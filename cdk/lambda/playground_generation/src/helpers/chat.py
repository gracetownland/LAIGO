import boto3, re, time
from langchain_aws import ChatBedrockConverse
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_community.chat_message_histories import DynamoDBChatMessageHistory
from pydantic import BaseModel, Field

class LLM_evaluation(BaseModel):
    response: str = Field(description="Assessment of the student's answer with a follow-up question.")

def get_bedrock_llm(
    bedrock_llm_id: str,
    temperature: float = 0,
    max_tokens: int = 4096,
    top_p: float = 0.9,
) -> ChatBedrockConverse:
    """
    Retrieve a Bedrock LLM instance based on the provided model ID.

    Args:
    bedrock_llm_id (str): The unique identifier for the Bedrock LLM model.
    temperature (float, optional): The temperature parameter for the LLM. Defaults to 0.
    max_tokens (int, optional): The maximum number of tokens to generate. Defaults to 4096.
    top_p (float, optional): The top_p parameter for the LLM. Defaults to 0.9.

    Returns:
    ChatBedrockConverse: An instance of the Bedrock LLM corresponding to the provided model ID.
    """
    return ChatBedrockConverse(
        model=bedrock_llm_id,
        temperature=temperature,
        max_tokens=max_tokens,
        top_p=top_p,
    )


def get_initial_student_query(case_type: str, jurisdiction: str, case_description: str) -> str:
    """
    Generate an initial query for the student to interact with the system.
    The query asks the student to greet the system and then requests a question related to a specified case.

    Args:
    case_type (str): The type of case being discussed.
    jurisdiction (str): The jurisdiction the case is under.
    case_description (str): A brief description of the case.

    Returns:
    str: The formatted initial query string for the student.
    """
    student_query = f"""
    Greet me and ask if I'm ready to start talking about the case.

    Be prepared to answer questions about the case, with the following context (you do not need to say anything about the context in your response yet, just ingest it):
    Case type: {case_type}
    Jurisdiction: {jurisdiction}
    Case description: {case_description}
    This is the end of the current context. Prepare to be asked about the case.
    """
    return student_query


def construct_case_context_prompt(system_prompt: str, case_context: dict) -> str:
    """
    Wraps the system prompt with case context details.
    
    Args:
        system_prompt (str): The core system prompt.
        case_context (dict): Dictionary containing case details (type, jurisdiction, description, etc.)
        
    Returns:
        str: The fully constructed system prompt with context.
    """
    case_type = case_context.get("case_type", "")
    jurisdiction = case_context.get("jurisdiction", "")
    case_description = case_context.get("case_description", "")
    province = case_context.get("province", "")
    statute = case_context.get("statute", "")
    
    return f"""
        Case Context:
        {system_prompt}
        Pay close attention to the latest system prompt I've given you, as it may have been updated since the last message, but don't entirely discard the previous system prompts unless they conflict. This is for your behaviour, you do not need to include it in the response.

        Additional case details that are relevant:
        Case type: {case_type}
        Jurisdiction: {jurisdiction}
        Case description: {case_description}
        Province (blank if not under provincial jurisdiction): {province}
        Statute (blank if not applicable): {statute}
        
        Relevant documents are not injected in this workflow.
        """

def get_response(
    query: str,
    province: str,
    statute:  str,
    llm: ChatBedrockConverse,
    table_name: str,
    case_id: str,
    system_prompt: str,
    case_type: str,
    jurisdiction: str,
    case_description: str,
) -> dict:
    """
    Generates a response to a query using the LLM and a history-aware retriever for context.

    Args:
    query (str): The student's query string for which a response is needed.
    case_name (str): The specific case that the student needs to analyze.
    llm (ChatBedrockConverse): The language model instance used to generate the response.
    table_name (str): The DynamoDB table name used to store and retrieve the chat history.
    session_id (str): The unique identifier for the chat session to manage history.

    Returns:
    dict: A dictionary containing the generated response and the source documents used in the retrieval.
    """

    # Create a system prompt for the question answering
    case_context = {
        "case_type": case_type,
        "jurisdiction": jurisdiction,
        "case_description": case_description,
        "province": province,
        "statute": statute
    }
    
    processed_system_prompt = construct_case_context_prompt(system_prompt, case_context)
    
    qa_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", processed_system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    conversational_chain = RunnableWithMessageHistory(
        qa_prompt | llm,
        lambda _: DynamoDBChatMessageHistory(
            table_name=table_name, 
            session_id=case_id  # Uses case_id from function scope
        ),
        input_messages_key="input",
        history_messages_key="chat_history",
    )
    
    # Generate the response until it's not empty
    response = ""
    while not response:
        response = generate_response(
            conversational_chain,
            query,
            case_id
        )
    
    return get_llm_output(response)

def generate_response(conversational_rag_chain: object, query: str, case_id: str) -> str:
    """
    Invokes the RAG chain to generate a response to a given query.

    Args:
    conversational_rag_chain: The Conversational RAG chain object that processes the query and retrieves relevant responses.
    query (str): The input query for which the response is being generated.
    session_id (str): The unique identifier for the current conversation session.

    Returns:
    str: The answer generated by the Conversational RAG chain, based on the input query and session context.
    """
    response = conversational_rag_chain.invoke(
        {
            "input": query
        },
        config={
            "configurable": {"session_id": case_id}
        },  # constructs a key "session_id" in `store`.
    )

    if hasattr(response, "content"):
        return response.content
    return str(response)

def get_llm_output(response: str) -> dict:
    """
    Processes the response from the LLM to determine if proper diagnosis has been achieved.

    Args:
    response (str): The response generated by the LLM.

    Returns:
    dict: A dictionary containing the processed output from the LLM.
    """
    return dict(
        llm_output=response
    )

def get_streaming_response(
    query: str,
    province: str,
    statute: str,
    llm: ChatBedrockConverse,
    table_name: str,
    case_id: str,
    system_prompt: str,
    case_type: str,
    jurisdiction: str,
    case_description: str,
    connection_id: str,
    websocket_endpoint: str,
    request_id: str = None,
) -> dict:
    """
    Generates a streaming response to a query and pushes chunks back to WebSocket client.

    Args:
    query (str): The student's query string.
    connection_id (str): WebSocket connection ID for pushing messages.
    websocket_endpoint (str): HTTPS endpoint for ApiGatewayManagementApi.
    ... (other args same as get_response)

    Returns:
    dict: A dictionary containing the full response after streaming completes.
    """
    import boto3
    import json

    # Initialize ApiGatewayManagementApi client
    apigw_client = boto3.client(
        'apigatewaymanagementapi',
        endpoint_url=websocket_endpoint
    )

    def send_to_websocket(message_type: str, content: str = None, data: dict = None):
        """Helper to send messages to WebSocket connection with request correlation."""
        message = {
            "requestId": request_id,
            "action": "generate_text",
            "type": message_type,
        }
        if content is not None:
            message["content"] = content
        if data is not None:
            message["data"] = data
        try:
            apigw_client.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps(message).encode('utf-8')
            )
        except Exception as e:
            print(f"Error sending to WebSocket: {e}")

    # Create a system prompt for the question answering
    case_context = {
        "case_type": case_type,
        "jurisdiction": jurisdiction,
        "case_description": case_description,
        "province": province,
        "statute": statute
    }
    
    processed_system_prompt = construct_case_context_prompt(system_prompt, case_context)
    
    qa_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", processed_system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    history = DynamoDBChatMessageHistory(
        table_name=table_name,
        session_id=case_id,
    )
    conversational_chain = qa_prompt | llm
    chat_history = history.messages
    
    # Send start message
    send_to_websocket("start")
    
    full_response = ""
    try:
        # Stream the response
        for chunk in conversational_chain.stream(
            {"input": query, "chat_history": chat_history}
        ):
            chunk_content = _extract_chunk_text(chunk)
            if chunk_content:
                full_response += chunk_content
                send_to_websocket("chunk", content=chunk_content)

        # Persist only complete messages to avoid storing stream chunk message types.
        history.add_messages(
            [
                HumanMessage(content=query),
                AIMessage(content=full_response),
            ]
        )
        
        # Send complete message
        send_to_websocket("complete", data={"llm_output": full_response})
        
    except Exception as e:
        send_to_websocket("error", content="An unexpected error occurred. Please try again later or contact an administrator.")
        raise
    
    return get_llm_output(full_response)
 
def get_playground_streaming_response(
    query: str,
    llm: ChatBedrockConverse,
    table_name: str,
    session_id: str,
    system_prompt: str,
    connection_id: str,
    websocket_endpoint: str,
    request_id: str = None,
    case_context: dict = None,
) -> dict:
    """
    Generates a streaming response for playground testing.
    Uses the exact same chain structure as get_streaming_response for complete
    architectural consistency, including history-aware query rephrasing.
    Uses DynamoDB for multi-turn conversation history.
    
    Args:
    query (str): The user's test message.
    llm (ChatBedrockConverse): The language model instance.
    table_name (str): DynamoDB table name for chat history.
    session_id (str): Unique session ID for playground conversation.
    system_prompt (str): Custom system prompt to test.
    connection_id (str): WebSocket connection ID.
    websocket_endpoint (str): HTTPS endpoint for ApiGatewayManagementApi.
    request_id (str, optional): Request correlation ID.
    case_context (dict, optional): Mock case details to wrap the prompt with.
    
    Returns:
    dict: A dictionary containing the full response after streaming completes.
    """
    import json
    
    # Initialize ApiGatewayManagementApi client
    apigw_client = boto3.client(
        'apigatewaymanagementapi',
        endpoint_url=websocket_endpoint
    )

    def send_to_websocket(message_type: str, content: str = None, data: dict = None):
        """Helper to send messages to WebSocket connection."""
        message = {
            "requestId": request_id,
            "action": "playground_test",
            "type": message_type,
        }
        if content is not None:
            message["content"] = content
        if data is not None:
            message["data"] = data
        try:
            apigw_client.post_to_connection(
                ConnectionId=connection_id,
                Data=json.dumps(message).encode('utf-8')
            )
        except Exception as e:
            print(f"Error sending to WebSocket: {e}")

    # Construct the prompt with case context details (consistent with standard flow)
    if case_context is None:
        case_context = {}
        
    processed_system_prompt = construct_case_context_prompt(system_prompt, case_context)
    
    qa_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", processed_system_prompt),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ]
    )
    history = DynamoDBChatMessageHistory(
        table_name=table_name,
        session_id=session_id,
    )
    conversational_chain = qa_prompt | llm
    chat_history = history.messages
    
    # Send start message
    send_to_websocket("start")
    
    full_response = ""
    try:
        # Stream the response
        for chunk in conversational_chain.stream(
            {"input": query, "chat_history": chat_history}
        ):
            chunk_content = _extract_chunk_text(chunk)
            if chunk_content:
                full_response += chunk_content
                send_to_websocket("chunk", content=chunk_content)

        # Persist only complete messages to avoid storing stream chunk message types.
        history.add_messages(
            [
                HumanMessage(content=query),
                AIMessage(content=full_response),
            ]
        )

        
        # Send complete message
        send_to_websocket("complete", data={"llm_output": full_response})
        
        # Update TTL AFTER conversation is saved by LangChain
        try:
            dynamodb = boto3.resource("dynamodb")
            table = dynamodb.Table(table_name)
            
            # Check current TTL first to avoid unnecessary writes
            response = table.get_item(
                Key={'SessionId': session_id}
            )
            
            current_time = int(time.time())
            expiry_timestamp = current_time + 86400  # 24 hours
            
            # Only update if TTL is missing or expires in less than 23 hours (update roughly every hour)
            should_update = True
            if 'Item' in response and 'ttl' in response['Item']:
                current_ttl = int(response['Item']['ttl'])
                # If existing TTL is still good for > 23 hours, don't write
                if current_ttl > (current_time + 82800):
                    should_update = False
            
            if should_update:
                table.update_item(
                    Key={'SessionId': session_id},
                    UpdateExpression="SET #ttl = :expiry",
                    ExpressionAttributeNames={'#ttl': 'ttl'},
                    ExpressionAttributeValues={':expiry': expiry_timestamp}
                )
        except Exception as e:
            print(f"Error setting TTL for playground session: {e}")
        
    except Exception as e:
        send_to_websocket("error", content="An unexpected error occurred. Please try again later or contact an administrator.")
        raise
    
    return get_llm_output(full_response)


def _extract_chunk_text(chunk) -> str:
    """Normalize Bedrock stream chunks to plain text."""
    if chunk is None:
        return ""
    if hasattr(chunk, "content"):
        content = chunk.content
    else:
        content = chunk

    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""

def split_into_sentences(paragraph: str) -> list[str]:
    """
    Splits a given paragraph into individual sentences using a regular expression to detect sentence boundaries.

    Args:
    paragraph (str): The input text paragraph to be split into sentences.

    Returns:
    list: A list of strings, where each string is a sentence from the input paragraph.

    This function uses a regular expression pattern to identify sentence boundaries, such as periods, question marks, 
    or exclamation marks, and avoids splitting on abbreviations (e.g., "Dr." or "U.S.") by handling edge cases. The 
    resulting list contains sentences extracted from the input paragraph.
    """
    # Regular expression pattern
    sentence_endings = r'(?<!\w\.\w.)(?<![A-Z][a-z]\.)(?<=\.|\?|\!)\s'
    sentences = re.split(sentence_endings, paragraph)
    return sentences

def update_session_name(table_name: str, session_id: str, bedrock_llm_id: str) -> str:
    """
    Check if both the LLM and the student have exchanged exactly one message each.
    If so, generate and return a session name using the content of the student's first message
    and the LLM's first response. Otherwise, return None.

    Args:
    session_id (str): The unique ID for the session.
    table_name (str): The DynamoDB table name where the conversation history is stored.

    Returns:
    str: The updated session name if conditions are met, otherwise None.
    """
    
    dynamodb_client = boto3.client("dynamodb")
    
    # Retrieve the conversation history from the DynamoDB table
    try:
        response = dynamodb_client.get_item(
            TableName=table_name,
            Key={
                'SessionId': {
                    'S': session_id
                }
            }
        )
    except Exception as e:
        print(f"Error fetching conversation history from DynamoDB: {e}")
        return None

    history = response.get('Item', {}).get('History', {}).get('L', [])



    human_messages = []
    ai_messages = []
    
    # Find the first human and ai messages in the history
    # Check if length of human messages is 2 since the prompt counts as 1
    # Check if length of AI messages is 2 since after first response by student, another response is generated
    for item in history:
        message_type = item.get('M', {}).get('data', {}).get('M', {}).get('type', {}).get('S')
        
        if message_type == 'human':
            human_messages.append(item)
            if len(human_messages) > 2:
                print("More than one student message found; not the first exchange.")
                return None
        
        elif message_type == 'ai':
            ai_messages.append(item)
            if len(ai_messages) > 2:
                print("More than one AI message found; not the first exchange.")
                return None

    if len(human_messages) != 2 or len(ai_messages) != 2:
        print("Not a complete first exchange between the LLM and student.")
        return None
    
    student_message = human_messages[0].get('M', {}).get('data', {}).get('M', {}).get('content', {}).get('S', "")
    llm_message = ai_messages[0].get('M', {}).get('data', {}).get('M', {}).get('content', {}).get('S', "")
    
    llm = get_bedrock_llm(bedrock_llm_id)
    
    title_system_prompt = """
        You are given the first message from an AI and the first message from a student in a conversation. 
        Based on these two messages, come up with a name that describes the conversation. 
        The name should be less than 30 characters. ONLY OUTPUT THE NAME YOU GENERATED. NO OTHER TEXT.
    """
    
    prompt = f"""
        System: {title_system_prompt}
        
        AI Message: {llm_message}
        
        Student Message: {student_message}
    """
    
    response = llm.invoke(prompt)
    session_name = response.content if hasattr(response, 'content') else str(response)
    return session_name