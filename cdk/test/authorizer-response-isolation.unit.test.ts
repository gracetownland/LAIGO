/**
 * Unit Tests: Authorizer Response Isolation
 *
 * Tests each authorizer (admin, student, instructor) with sequential invocations
 * simulating warm Lambda reuse. Verifies no state leakage between invocations
 * and that each returned policy has exactly one Statement.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

// Import the shared buildAuthResponse factory used by all three authorizers
const { buildAuthResponse } = require("../lambda/authorization/authResponseBuilder");

describe("Authorizer Response Isolation - Unit Tests", () => {
  describe("Admin Authorizer (Requirement 3.4)", () => {
    it("produces isolated responses across 3 sequential invocations", () => {
      // Simulate 3 warm Lambda invocations with different admin users
      const response1 = buildAuthResponse(
        "admin-user-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/admin/users",
        { userId: "admin-user-001", email: "admin1@example.com", firstName: "Alice", lastName: "Admin", roles: '["admin"]' }
      );

      const response2 = buildAuthResponse(
        "admin-user-002",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/admin/cases",
        { userId: "admin-user-002", email: "admin2@example.com", firstName: "Bob", lastName: "Boss", roles: '["admin"]' }
      );

      const response3 = buildAuthResponse(
        "admin-user-003",
        "Deny",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/DELETE/admin/users",
        { userId: "admin-user-003", email: "admin3@example.com", firstName: "Charlie", lastName: "Chief", roles: '["admin"]' }
      );

      // Each response has exactly one Statement
      expect(response1.policyDocument.Statement).toHaveLength(1);
      expect(response2.policyDocument.Statement).toHaveLength(1);
      expect(response3.policyDocument.Statement).toHaveLength(1);

      // Each Statement matches its own invocation parameters
      expect(response1.policyDocument.Statement[0].Effect).toBe("Allow");
      expect(response1.policyDocument.Statement[0].Resource).toContain("GET/admin/users");
      expect(response2.policyDocument.Statement[0].Effect).toBe("Allow");
      expect(response2.policyDocument.Statement[0].Resource).toContain("POST/admin/cases");
      expect(response3.policyDocument.Statement[0].Effect).toBe("Deny");
      expect(response3.policyDocument.Statement[0].Resource).toContain("DELETE/admin/users");

      // Principal IDs are correct per invocation
      expect(response1.principalId).toBe("admin-user-001");
      expect(response2.principalId).toBe("admin-user-002");
      expect(response3.principalId).toBe("admin-user-003");
    });

    it("mutating one response does not affect others", () => {
      const response1 = buildAuthResponse(
        "admin-mut-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/admin/dashboard",
        { userId: "admin-mut-001", email: "mut@example.com", firstName: "Mut", lastName: "Test", roles: '["admin"]' }
      );

      const response2 = buildAuthResponse(
        "admin-mut-002",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/admin/settings",
        { userId: "admin-mut-002", email: "mut2@example.com", firstName: "Mut2", lastName: "Test2", roles: '["admin"]' }
      );

      // Mutate response1's Statement array
      response1.policyDocument.Statement.push({
        Action: "INJECTED",
        Effect: "Allow",
        Resource: "*",
      });

      // response2 must be unaffected
      expect(response2.policyDocument.Statement).toHaveLength(1);
      expect(response2.policyDocument.Statement[0].Action).toBe("execute-api:Invoke");

      // Mutate response1's context
      response1.context.injected = "malicious";
      expect(response2.context).not.toHaveProperty("injected");
    });
  });

  describe("Student Authorizer (Requirement 3.4)", () => {
    it("produces isolated responses across 3 sequential invocations", () => {
      // Simulate 3 warm Lambda invocations with different student users
      const response1 = buildAuthResponse(
        "student-user-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/student/cases",
        { userId: "student-user-001", email: "student1@uni.edu", firstName: "Dana", lastName: "Doe", roles: '["student"]' }
      );

      const response2 = buildAuthResponse(
        "student-user-002",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/student/profile",
        { userId: "student-user-002", email: "student2@uni.edu", firstName: "Eve", lastName: "Evans", roles: '["student"]' }
      );

      const response3 = buildAuthResponse(
        "student-user-003",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/student/messages",
        { userId: "student-user-003", email: "student3@uni.edu", firstName: "Frank", lastName: "Fisher", roles: '["student"]' }
      );

      // Each response has exactly one Statement
      expect(response1.policyDocument.Statement).toHaveLength(1);
      expect(response2.policyDocument.Statement).toHaveLength(1);
      expect(response3.policyDocument.Statement).toHaveLength(1);

      // No cross-contamination of principal IDs
      expect(response1.principalId).toBe("student-user-001");
      expect(response2.principalId).toBe("student-user-002");
      expect(response3.principalId).toBe("student-user-003");

      // Context is isolated per invocation
      expect(response1.context.email).toBe("student1@uni.edu");
      expect(response2.context.email).toBe("student2@uni.edu");
      expect(response3.context.email).toBe("student3@uni.edu");
    });

    it("Statement arrays are distinct references across invocations", () => {
      const response1 = buildAuthResponse(
        "student-ref-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/student/cases",
        { userId: "student-ref-001", email: "ref1@uni.edu", firstName: "A", lastName: "B", roles: '["student"]' }
      );

      const response2 = buildAuthResponse(
        "student-ref-002",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/student/cases",
        { userId: "student-ref-002", email: "ref2@uni.edu", firstName: "C", lastName: "D", roles: '["student"]' }
      );

      // Statement arrays must be different object references
      expect(response1.policyDocument.Statement).not.toBe(response2.policyDocument.Statement);

      // Policy documents must be different object references
      expect(response1.policyDocument).not.toBe(response2.policyDocument);

      // Context objects must be different references
      expect(response1.context).not.toBe(response2.context);
    });
  });

  describe("Instructor Authorizer (Requirement 3.4)", () => {
    it("produces isolated responses across 2 sequential invocations", () => {
      // Simulate 2 warm Lambda invocations with different instructor users
      const response1 = buildAuthResponse(
        "instructor-user-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/instructor/courses",
        { userId: "instructor-user-001", email: "prof1@uni.edu", firstName: "Grace", lastName: "Green", roles: '["instructor"]' }
      );

      const response2 = buildAuthResponse(
        "instructor-user-002",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/instructor/feedback",
        { userId: "instructor-user-002", email: "prof2@uni.edu", firstName: "Henry", lastName: "Hall", roles: '["instructor"]' }
      );

      // Each response has exactly one Statement
      expect(response1.policyDocument.Statement).toHaveLength(1);
      expect(response2.policyDocument.Statement).toHaveLength(1);

      // Statements match their respective invocations
      expect(response1.policyDocument.Statement[0].Resource).toContain("instructor/courses");
      expect(response2.policyDocument.Statement[0].Resource).toContain("instructor/feedback");

      // Principal IDs are correct
      expect(response1.principalId).toBe("instructor-user-001");
      expect(response2.principalId).toBe("instructor-user-002");
    });

    it("mutating one response does not affect subsequent responses", () => {
      const response1 = buildAuthResponse(
        "instructor-mut-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/instructor/grades",
        { userId: "instructor-mut-001", email: "mut@uni.edu", firstName: "Mut", lastName: "Prof", roles: '["instructor"]' }
      );

      // Mutate response1 before creating response2
      response1.policyDocument.Statement.push({
        Action: "LEAKED",
        Effect: "Allow",
        Resource: "*",
      });
      response1.context.leaked = "true";

      // Create response2 after mutation
      const response2 = buildAuthResponse(
        "instructor-mut-002",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/GET/instructor/students",
        { userId: "instructor-mut-002", email: "clean@uni.edu", firstName: "Clean", lastName: "Prof", roles: '["instructor"]' }
      );

      // response2 must not be affected by response1's mutations
      expect(response2.policyDocument.Statement).toHaveLength(1);
      expect(response2.policyDocument.Statement[0].Action).toBe("execute-api:Invoke");
      expect(response2.context).not.toHaveProperty("leaked");
    });
  });

  describe("Cross-role isolation (Requirement 3.4)", () => {
    it("responses from different authorizer roles do not share state", () => {
      // Simulate a sequence where admin, student, and instructor authorizers
      // are invoked in sequence (as if sharing the same buildAuthResponse module)
      const adminResponse = buildAuthResponse(
        "cross-admin-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*/admin/*",
        { userId: "cross-admin-001", email: "admin@example.com", firstName: "Admin", lastName: "User", roles: '["admin"]' }
      );

      const studentResponse = buildAuthResponse(
        "cross-student-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*/student/*",
        { userId: "cross-student-001", email: "student@uni.edu", firstName: "Student", lastName: "User", roles: '["student"]' }
      );

      const instructorResponse = buildAuthResponse(
        "cross-instructor-001",
        "Allow",
        "arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*/instructor/*",
        { userId: "cross-instructor-001", email: "prof@uni.edu", firstName: "Prof", lastName: "User", roles: '["instructor"]' }
      );

      // Each has exactly one Statement
      expect(adminResponse.policyDocument.Statement).toHaveLength(1);
      expect(studentResponse.policyDocument.Statement).toHaveLength(1);
      expect(instructorResponse.policyDocument.Statement).toHaveLength(1);

      // Resources are scoped correctly per role
      expect(adminResponse.policyDocument.Statement[0].Resource).toContain("admin");
      expect(studentResponse.policyDocument.Statement[0].Resource).toContain("student");
      expect(instructorResponse.policyDocument.Statement[0].Resource).toContain("instructor");

      // No shared references
      expect(adminResponse.policyDocument.Statement).not.toBe(studentResponse.policyDocument.Statement);
      expect(studentResponse.policyDocument.Statement).not.toBe(instructorResponse.policyDocument.Statement);
      expect(adminResponse.context).not.toBe(studentResponse.context);
    });
  });
});
