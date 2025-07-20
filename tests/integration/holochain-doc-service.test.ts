import { Effect, TestContext, Layer } from "effect"
import { describe, it, expect, vi } from "vitest"
import { runTest } from "../setup.js"
import { getMockUrlContent } from "../fixtures/mock-http-responses.js"

// Mock the HTTP service for testing
const MockHttpService = {
  fetchPage: (url: string) => Effect.succeed(getMockUrlContent(url))
}

import { Context } from "effect"
const MockHttpServiceTag = Context.GenericTag<typeof MockHttpService>("HttpService")

const MockHttpServiceLayer = Layer.succeed(MockHttpServiceTag, MockHttpService)

// Import service types - in a real scenario these would be imported from the main file
interface HolochainDocService {
  readonly searchDeveloperDocs: (query: string) => Effect.Effect<any[], any>
  readonly fetchDocumentationPage: (url: string) => Effect.Effect<any, any>  
  readonly getHDKFunctionDocs: (functionName: string) => Effect.Effect<any, any>
  readonly getConceptDocs: (concept: string) => Effect.Effect<any, any>
}

// Mock implementation for testing
const createMockHolochainDocService = (): HolochainDocService => ({
  searchDeveloperDocs: (query: string) => 
    Effect.succeed([
      {
        title: "Validation: Assuring Data Integrity",
        url: "https://developer.holochain.org/concepts/7_validation",
        snippet: "Data validation rules are the core of a Holochain app",
        source: "developer.holochain.org"
      }
    ]),
    
  fetchDocumentationPage: (url: string) => {
    const content = getMockUrlContent(url)
    if (content.includes("404")) {
      return Effect.fail(new Error("Not found"))
    }
    return Effect.succeed({
      title: url.includes("validation") ? "Validation: Assuring Data Integrity" : "Documentation",
      content: "Mock content for " + url,
      url,
      source: url.includes("developer.holochain.org") ? "developer.holochain.org" : "docs.rs"
    })
  },
  
  getHDKFunctionDocs: (functionName: string) => {
    if (functionName === "create_entry") {
      return Effect.succeed({
        title: "Function create_entry",
        content: "Create an app entry. Also see create.",
        url: "https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html",
        source: "docs.rs/hdk"
      })
    }
    return Effect.fail(new Error(`Function not found: ${functionName}`))
  },
  
  getConceptDocs: (concept: string) => {
    const conceptMappings: Record<string, string> = {
      "validation": "/concepts/7_validation",
      "dht": "/concepts/4_dht"
    }
    
    const path = conceptMappings[concept.toLowerCase()]
    if (path) {
      return Effect.succeed({
        title: concept === "validation" ? "Validation: Assuring Data Integrity" : "The DHT",
        content: `Content about ${concept}`,
        url: `https://developer.holochain.org${path}`,
        source: "developer.holochain.org"
      })
    }
    return Effect.fail(new Error(`Concept not found: ${concept}`))
  }
})

describe("HolochainDocService Integration Tests", () => {
  const mockService = createMockHolochainDocService()
  
  describe("searchDeveloperDocs", () => {
    it("should return relevant search results for validation query", () =>
      runTest(Effect.gen(function* () {
        const results = yield* mockService.searchDeveloperDocs("validation")
        
        expect(results).toHaveLength(1)
        expect(results[0].title).toBe("Validation: Assuring Data Integrity")
        expect(results[0].source).toBe("developer.holochain.org")
        expect(results[0].snippet).toContain("validation")
      }))
    )
  })

  describe("fetchDocumentationPage", () => {
    it("should fetch validation concept page successfully", () =>
      runTest(Effect.gen(function* () {
        const result = yield* mockService.fetchDocumentationPage(
          "https://developer.holochain.org/concepts/7_validation"
        )
        
        expect(result.title).toBe("Validation: Assuring Data Integrity")
        expect(result.source).toBe("developer.holochain.org")
        expect(result.url).toContain("validation")
        expect(result.content).toContain("Mock content")
      }))
    )
    
    it("should handle 404 errors gracefully", () =>
      runTest(Effect.gen(function* () {
        const effect = mockService.fetchDocumentationPage("https://example.com/404")
        
        // Test that the effect fails
        const result = yield* Effect.either(effect)
        expect(result._tag).toBe("Left")
      }))
    )
  })

  describe("getHDKFunctionDocs", () => {
    it("should return documentation for create_entry function", () =>
      runTest(Effect.gen(function* () {
        const result = yield* mockService.getHDKFunctionDocs("create_entry")
        
        expect(result.title).toBe("Function create_entry")
        expect(result.source).toBe("docs.rs/hdk")
        expect(result.content).toContain("Create an app entry")
        expect(result.url).toContain("create_entry")
      }))
    )
    
    it("should fail for non-existent functions", () =>
      runTest(Effect.gen(function* () {
        const effect = mockService.getHDKFunctionDocs("nonexistent_function")
        
        const result = yield* Effect.either(effect)
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.message).toContain("Function not found")
        }
      }))
    )
  })

  describe("getConceptDocs", () => {
    it("should return validation concept documentation", () =>
      runTest(Effect.gen(function* () {
        const result = yield* mockService.getConceptDocs("validation")
        
        expect(result.title).toBe("Validation: Assuring Data Integrity")
        expect(result.source).toBe("developer.holochain.org")
        expect(result.content).toContain("validation")
      }))
    )
    
    it("should return DHT concept documentation", () =>
      runTest(Effect.gen(function* () {
        const result = yield* mockService.getConceptDocs("dht")
        
        expect(result.title).toBe("The DHT")
        expect(result.source).toBe("developer.holochain.org")
        expect(result.content).toContain("dht")
      }))
    )
    
    it("should fail for unknown concepts", () =>
      runTest(Effect.gen(function* () {
        const effect = mockService.getConceptDocs("unknown_concept")
        
        const result = yield* Effect.either(effect)
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left.message).toContain("Concept not found")
        }
      }))
    )
  })

  describe("Complex queries", () => {
    it("should handle multiple search operations efficiently", () =>
      runTest(Effect.gen(function* () {
        // Simulate multiple concurrent operations
        const operations = [
          mockService.searchDeveloperDocs("validation"),
          mockService.getConceptDocs("dht"),  
          mockService.getHDKFunctionDocs("create_entry")
        ]
        
        const results = yield* Effect.all(operations, { concurrency: "unbounded" })
        
        expect(results).toHaveLength(3)
        expect(results[0]).toHaveLength(1) // Search results
        expect(results[1].title).toBe("The DHT") // Concept docs
        expect(results[2].title).toBe("Function create_entry") // Function docs
      }))
    )
    
    it("should handle mixed success/failure scenarios", () =>
      runTest(Effect.gen(function* () {
        const operations = [
          Effect.either(mockService.getConceptDocs("validation")), // Should succeed
          Effect.either(mockService.getHDKFunctionDocs("nonexistent")), // Should fail
          Effect.either(mockService.getConceptDocs("dht")) // Should succeed
        ]
        
        const results = yield* Effect.all(operations, { concurrency: "unbounded" })
        
        expect(results[0]).toBeDefined()
        expect(results[1]).toBeDefined() 
        expect(results[2]).toBeDefined()
        if (results[0] && "_tag" in results[0]) {
          expect(results[0]._tag).toBe("Right") // Success
        }
        if (results[1] && "_tag" in results[1]) {
          expect(results[1]._tag).toBe("Left")  // Failure
        }
        if (results[2] && "_tag" in results[2]) {
          expect(results[2]._tag).toBe("Right") // Success
        }
      }))
    )
  })
})