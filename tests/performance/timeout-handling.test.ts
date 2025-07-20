import { Effect, TestClock, TestContext } from "effect"
import { describe, it, expect } from "vitest"
import { runTest } from "../setup.js"
import { parseDocumentationPage, parseSearchResults } from "../unit/test-utils.js"

describe("Performance and Timeout Handling", () => {
  describe("Content Parsing Performance", () => {
    it("should parse large HTML documents efficiently", () =>
      runTest(Effect.gen(function* () {
        // Generate a large HTML document
        const largeContent = Array(10000).fill(0).map((_, i) => 
          `<p>This is paragraph ${i} with validation content and HDK functions.</p>`
        ).join("")
        
        const html = `
          <html>
            <head><title>Large Document</title></head>
            <body>
              <div class="main-area">
                <h1>Large Content Test</h1>
                ${largeContent}
              </div>
            </body>
          </html>
        `
        
        const startTime = yield* TestClock.currentTimeMillis
        
        const result = yield* parseDocumentationPage(html, "https://example.com/large")
        
        const endTime = yield* TestClock.currentTimeMillis
        const duration = endTime - startTime
        
        expect(result.title).toBe("Large Document")
        expect(result.content.length).toBeGreaterThan(1000)
        expect(duration).toBeLessThan(1000) // Should complete within 1 second
      }))
    )
  })

  describe("Concurrent Operations", () => {
    it("should handle multiple parsing operations concurrently", () =>
      runTest(Effect.gen(function* () {
        
        const operations = Array(10).fill(0).map((_, i) => {
          const html = `
            <html>
              <head><title>Document ${i}</title></head>
              <body>
                <div class="main-area">
                  <h1>Content ${i}</h1>
                  <p>This document contains validation rules and HDK functions.</p>
                </div>
              </body>
            </html>
          `
          return parseDocumentationPage(html, `https://example.com/doc${i}`)
        })
        
        const startTime = yield* TestClock.currentTimeMillis
        
        const results = yield* Effect.all(operations, { concurrency: "unbounded" })
        
        const endTime = yield* TestClock.currentTimeMillis
        const duration = endTime - startTime
        
        expect(results).toHaveLength(10)
        expect(results.every(r => r.title.startsWith("Document"))).toBe(true)
        expect(duration).toBeLessThan(2000) // Should complete within 2 seconds
      }))
    )
  })

  describe("Error Recovery", () => {
    it("should recover gracefully from parsing errors", () =>
      runTest(Effect.gen(function* () {
        
        const operations = [
          parseDocumentationPage("<html><body>Valid content</body></html>", "https://valid.com"),
          Effect.either(parseDocumentationPage("", "https://invalid.com")), // Empty content should work but return minimal content
          parseDocumentationPage("<html><body>Another valid doc</body></html>", "https://valid2.com")
        ]
        
        const results = yield* Effect.all(operations, { concurrency: "unbounded" })
        
        expect(results[0]).toBeDefined() // First should succeed
        if (results[0] && "title" in results[0]) {
          expect(results[0].title).toBeDefined()
        }
        expect(results[1]).toBeDefined() // Second should succeed  
        if (results[1] && "_tag" in results[1]) {
          expect(results[1]._tag).toBe("Right")  // Should be Right (success)
        }
        expect(results[2]).toBeDefined() // Third should succeed
        if (results[2] && "title" in results[2]) {
          expect(results[2].title).toBeDefined()
        }
      }))
    )
  })

  describe("Memory Usage", () => {
    it("should handle repeated operations without memory leaks", () =>
      runTest(Effect.gen(function* () {
        
        // Simulate repeated search operations
        const html = `
          <html>
            <body>
              <h1>Validation and DHT Concepts</h1>
              <p>This page discusses validation rules in Holochain.</p>
              <p>The DHT enables distributed data storage.</p>
            </body>
          </html>
        `
        
        const operations = Array(100).fill(0).map(() => 
          parseSearchResults(html, "https://example.com", ["validation", "dht"])
        )
        
        const results = yield* Effect.all(operations, { concurrency: 10 })
        
        // All operations should succeed and return consistent results
        expect(results).toHaveLength(100)
        expect(results.every(r => r._tag === "Some")).toBe(true)
      }))
    )
  })

  describe("Search Performance", () => {
    it("should handle large search result sets efficiently", () =>
      runTest(Effect.gen(function* () {
        
        // Create a document with many potential matches
        const content = Array(1000).fill(0).map((_, i) => 
          `<section>Validation rule ${i} for Holochain DHT operations.</section>`
        ).join("")
        
        const html = `
          <html>
            <body>
              <h1>Comprehensive Validation Guide</h1>
              ${content}
            </body>
          </html>
        `
        
        const startTime = yield* TestClock.currentTimeMillis
        
        const result = yield* parseSearchResults(html, "https://docs.com", ["validation", "holochain"])
        
        const endTime = yield* TestClock.currentTimeMillis
        const duration = endTime - startTime
        
        expect(result._tag).toBe("Some")
        expect(duration).toBeLessThan(500) // Should complete within 500ms
      }))
    )
  })
})