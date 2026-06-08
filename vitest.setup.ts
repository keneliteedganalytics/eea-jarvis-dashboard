// Register @testing-library/jest-dom matchers only when a DOM is present.
// Server tests run under the `node` environment (no document); client tests
// opt into jsdom via `// @vitest-environment jsdom` and get the matchers.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}
