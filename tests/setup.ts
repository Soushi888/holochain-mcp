import { Effect, TestContext, Layer } from "effect"

// Global test setup for Effect
export const TestEnvironment = TestContext.TestContext

// Helper to run Effect in tests
export const runTest = <A, E>(effect: Effect.Effect<A, E, typeof TestContext.TestContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestEnvironment)))

// Set test environment variables  
process.env.NODE_ENV = 'test'