/**
 * Property-Based Test: Authorizer Response Isolation
 *
 * Feature: security-hardening
 * Property 1: Authorizer response isolation
 *
 * Validates: Requirements 3.1, 3.3
 *
 * For any sequence of authorization requests processed by the same warm Lambda
 * instance, each response SHALL contain exactly one IAM policy Statement entry
 * corresponding to the current request, with no accumulation from previous
 * invocations and no shared object references between responses.
 */

import * as fc from "fast-check";

// Shared implementation used by admin, student, and instructor authorizers.
// Import directly to avoid loading Lambda runtime deps (AWS SDK, etc.) in Jest.
const { buildAuthResponse } = require("../lambda/authorization/authResponseBuilder");

// --- Generators ---

/** Generate a random principal ID (simulating a database user_id) */
const principalIdArb = fc.stringMatching(/^[a-z0-9\-]{1,36}$/);

/** Generate a random IAM effect */
const effectArb = fc.constantFrom("Allow", "Deny");

/** Generate a random API Gateway method ARN */
const resourceArnArb = fc.tuple(
  fc.constantFrom("us-east-1", "us-west-2", "eu-west-1"),
  fc.stringMatching(/^[0-9]{12}$/),
  fc.constantFrom("execute-api"),
  fc.stringMatching(/^[a-z0-9]{6,10}$/),
  fc.constantFrom("prod", "dev", "staging"),
  fc.constantFrom("GET", "POST", "PUT", "DELETE"),
  fc.constantFrom("admin", "student", "instructor"),
  fc.stringMatching(/^[a-z\/_\-]{1,30}$/)
).map(([region, account, service, apiId, stage, method, role, path]) =>
  `arn:aws:${service}:${region}:${account}:${apiId}/${stage}/${method}/${role}/${path}`
);

/** Generate a random context object */
const contextArb = fc.oneof(
  fc.constant(undefined),
  fc.constant({}),
  fc.record({
    userId: principalIdArb,
    email: fc.stringMatching(/^[a-z]{1,8}@[a-z]{1,8}\.[a-z]{2,4}$/),
    firstName: fc.string({ minLength: 1, maxLength: 20 }),
    lastName: fc.string({ minLength: 1, maxLength: 20 }),
    roles: fc.constantFrom('["admin"]', '["student"]', '["instructor"]', '["admin","instructor"]'),
  })
);

/** Generate a single invocation tuple */
const invocationArb = fc.tuple(principalIdArb, effectArb, resourceArnArb, contextArb);

/** Generate a sequence of 2-10 invocations to simulate warm Lambda reuse */
const invocationSequenceArb = fc.array(invocationArb, { minLength: 2, maxLength: 10 });

// --- Test Suites ---

describe("Feature: security-hardening | Property 1: Authorizer response isolation", () => {
  describe("authResponseBuilder (admin, student, instructor authorizers)", () => {
      /**
       * **Validates: Requirements 3.1, 3.3**
       *
       * Property: Each response from buildAuthResponse contains exactly one
       * Statement entry, regardless of how many times it has been called previously.
       */
      it("each response contains exactly one Statement entry", () => {
        fc.assert(
          fc.property(invocationSequenceArb, (invocations) => {
            for (const [principalId, effect, resource, context] of invocations) {
              const response = buildAuthResponse(principalId, effect, resource, context);

              // Must have exactly one Statement
              expect(response.policyDocument.Statement).toHaveLength(1);

              // The single Statement must match the current invocation's parameters
              expect(response.policyDocument.Statement[0]).toEqual({
                Action: "execute-api:Invoke",
                Effect: effect,
                Resource: resource,
              });

              // principalId must match
              expect(response.principalId).toBe(principalId);
            }
          }),
          { numRuns: 100 }
        );
      });

      /**
       * **Validates: Requirements 3.1, 3.3**
       *
       * Property: No shared object references exist between consecutive responses.
       * Mutating one response does not affect any other response.
       */
      it("no shared object references between responses", () => {
        fc.assert(
          fc.property(invocationSequenceArb, (invocations) => {
            const responses = invocations.map(([principalId, effect, resource, context]) =>
              buildAuthResponse(principalId, effect, resource, context)
            );

            // Verify no shared references by mutating each response and checking others
            for (let i = 0; i < responses.length; i++) {
              // Mutate the Statement array of response[i]
              responses[i].policyDocument.Statement.push({
                Action: "MUTATED",
                Effect: "Deny",
                Resource: "*",
              });

              // Verify all OTHER responses still have exactly one Statement
              for (let j = 0; j < responses.length; j++) {
                if (j !== i) {
                  expect(responses[j].policyDocument.Statement).toHaveLength(1);
                }
              }

              // Mutate the context of response[i]
              if (responses[i].context) {
                responses[i].context.MUTATED = true;
              }

              // Verify other responses' contexts are unaffected
              for (let j = 0; j < responses.length; j++) {
                if (j !== i) {
                  expect(responses[j].context).not.toHaveProperty("MUTATED");
                }
              }

              // Restore for next iteration
              responses[i].policyDocument.Statement.pop();
              if (responses[i].context) {
                delete responses[i].context.MUTATED;
              }
            }
          }),
          { numRuns: 100 }
        );
      });
  });
});
