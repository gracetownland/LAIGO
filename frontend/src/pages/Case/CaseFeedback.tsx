import React, { useEffect, useState } from "react";
import {
  Box,
  Typography,
  CircularProgress,
  Container,
  TextField,
  Button,
  Snackbar,
  Alert,
} from "@mui/material";
import { fetchAuthSession } from "aws-amplify/auth";
import { useParams, useOutletContext } from "react-router-dom";
import FeedbackMessage from "../../components/Case/FeedbackMessage";
import SendIcon from "@mui/icons-material/Send";
import { useUser } from "../../contexts/UserContext";
import type { CaseOutletContext } from "./CaseLayout";

// Interface for feedback messages
interface FeedbackMessageData {
  id: string;
  sender: string;
  timestamp: string;
  content: string;
}

interface ApiFeedbackMessage {
  message_id: string;
  message_content: string;
  time_sent: string;
  first_name: string;
  last_name: string;
}

const CaseFeedback: React.FC = () => {
  const { caseId } = useParams();
  const { userInfo } = useUser();
  const { caseStatus } = useOutletContext<CaseOutletContext>();
  const [loading, setLoading] = useState<boolean>(true);
  const [messages, setMessages] = useState<FeedbackMessageData[]>([]);
  const [newFeedback, setNewFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Snackbar state
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const [snackbarSeverity, setSnackbarSeverity] = useState<"success" | "error">(
    "success",
  );

  const isSupervisor = userInfo?.groups?.includes("instructor");

  const loadFeedback = React.useCallback(async () => {
    try {
      setLoading(true);
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      if (!token) {
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/student/feedback?case_id=${caseId}`,
        {
          headers: {
            Authorization: token,
          },
        },
      );

      if (!response.ok) {
        throw new Error("Failed to fetch feedback");
      }

      const data: ApiFeedbackMessage[] = await response.json();

      const normalizedMessages: FeedbackMessageData[] = data.map((msg) => ({
        id: msg.message_id,
        sender:
          `${msg.first_name || "Supervisor"} ${msg.last_name || ""}`.trim(),
        timestamp: new Date(msg.time_sent).toLocaleString(),
        content: msg.message_content,
      }));

      setMessages(normalizedMessages);
    } catch (err) {
      showSnackbar("Failed to load feedback.", "error");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (caseId) {
      loadFeedback();
    }
  }, [caseId, loadFeedback]);

  const showSnackbar = (message: string, severity: "success" | "error") => {
    setSnackbarMessage(message);
    setSnackbarSeverity(severity);
    setSnackbarOpen(true);
  };

  const handleSendFeedback = async () => {
    if (!newFeedback.trim()) return;

    try {
      setSubmitting(true);
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      const instructorId = userInfo?.userId;

      if (!token || !instructorId) {
        showSnackbar("Authentication error", "error");
        return;
      }

      // instructor_id satisfies API Gateway required query param; Lambda uses authorizer userId
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/instructor/send_feedback?case_id=${caseId}&instructor_id=${instructorId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: token,
          },
          body: JSON.stringify({
            message_content: newFeedback,
          }),
        },
      );

      if (!response.ok) {
        let errorMsg = "Failed to send feedback";
        try {
          const errorData = await response.json();
          if (errorData.error) errorMsg = errorData.error;
        } catch {
          // ignore parse errors
        }
        throw new Error(errorMsg);
      }

      showSnackbar("Feedback sent successfully", "success");
      setNewFeedback("");
      loadFeedback(); // Refresh list
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send feedback";
      showSnackbar(message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteFeedback = async (messageId: string) => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      if (!token) {
        showSnackbar("Authentication error", "error");
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/instructor/delete_feedback?message_id=${messageId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: token,
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete feedback");
      }

      showSnackbar("Feedback deleted successfully", "success");
      loadFeedback(); // Refresh list
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to delete feedback";
      showSnackbar(message, "error");
    }
  };

  return (
    <Box
      sx={{
        width: "100%",
        minHeight: "calc(100vh - 80px)",
        backgroundColor: "var(--background)",
        color: "var(--text)",
        borderTop: "1px solid var(--border)",
        p: 4,
      }}
    >
      <Container maxWidth="lg">
        <Typography
          variant="h4"
          fontFamily="Outfit"
          fontWeight="500"
          mb={4}
          textAlign="left"
        >
          Case Feedback
        </Typography>

        <Box
          sx={{
            border: "1px solid var(--border)",
            borderRadius: 1,
            overflow: "hidden",
            backgroundColor: "transparent",
            p: 3,
          }}
        >
          {/* Supervisor Input Section */}
          {isSupervisor && (
            <Box sx={{ mb: 4 }}>
              <Typography
                variant="h6"
                fontFamily="Outfit"
                fontWeight="500"
                mb={2}
                textAlign="left"
              >
                Provide New Feedback
              </Typography>
              <TextField
                fullWidth
                multiline
                minRows={3}
                variant="outlined"
                placeholder={
                  caseStatus === "archived"
                    ? "Case archived - feedback disabled"
                    : "Enter feedback regarding the case approach"
                }
                value={newFeedback}
                onChange={(e) => setNewFeedback(e.target.value)}
                disabled={submitting || caseStatus === "archived"}
                sx={{
                  backgroundColor: "var(--background)",
                  marginBottom: 2,
                  "& .MuiOutlinedInput-root": {
                    color: "var(--text)",
                    "& fieldset": { borderColor: "var(--border)" },
                    "&:hover fieldset": {
                      borderColor: "var(--text-secondary)",
                    },
                    "&.Mui-focused fieldset": { borderColor: "var(--primary)" },
                    "&.Mui-disabled": {
                      backgroundColor: "rgba(0,0,0,0.05)",
                    },
                  },
                }}
              />
              <Box sx={{ display: "flex", justifyContent: "flex-start" }}>
                <Button
                  variant="contained"
                  startIcon={
                    submitting ? (
                      <CircularProgress size={20} color="inherit" />
                    ) : (
                      <SendIcon />
                    )
                  }
                  onClick={handleSendFeedback}
                  disabled={
                    submitting ||
                    !newFeedback.trim() ||
                    caseStatus === "archived"
                  }
                  sx={{
                    backgroundColor: "var(--primary)",
                    color: "var(--text)",
                    textTransform: "none",
                    fontWeight: "bold",
                    "&:hover": {
                      backgroundColor: "var(--primary)",
                      filter: "brightness(0.9)",
                    },
                    "&.Mui-disabled": {
                      backgroundColor: "var(--secondary)",
                      color: "#000000",
                    },
                  }}
                >
                  {submitting ? "Sending..." : "Send Feedback"}
                </Button>
              </Box>
              <Box
                sx={{
                  borderBottom: "1px solid var(--border)",
                  mt: 4,
                }}
              />
            </Box>
          )}

          {/* Header */}
          <Typography
            variant="h6"
            fontFamily="Outfit"
            textAlign="left"
            fontWeight="500"
            mb={2}
            mt={isSupervisor ? 4 : 0}
          >
            Previous feedback
          </Typography>

          {/* List content */}
          <Box sx={{ p: 0 }}>
            {loading ? (
              <Box sx={{ p: 4, display: "flex", justifyContent: "center" }}>
                <CircularProgress
                  size={30}
                  sx={{ color: "var(--text-secondary)" }}
                />
              </Box>
            ) : messages.length === 0 ? (
              <Box sx={{ p: 4 }}>
                <Typography color="var(--text-secondary)" textAlign="left">
                  No feedback yet.
                </Typography>
              </Box>
            ) : (
              <Box>
                {messages.map((msg) => (
                  <FeedbackMessage
                    key={msg.id}
                    sender={msg.sender}
                    timestamp={msg.timestamp}
                    content={msg.content}
                    onDelete={
                      isSupervisor && caseStatus !== "archived"
                        ? () => handleDeleteFeedback(msg.id)
                        : undefined
                    }
                  />
                ))}
              </Box>
            )}
          </Box>
        </Box>
      </Container>

      <Snackbar
        open={snackbarOpen}
        autoHideDuration={8000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setSnackbarOpen(false)}
          severity={snackbarSeverity}
          sx={{ width: "100%" }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default CaseFeedback;
