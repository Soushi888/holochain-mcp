import { Effect, TestContext } from "effect"
import { describe, it, expect } from "vitest"
import * as cheerio from "cheerio"
import { readFileSync } from "fs"
import { join } from "path"
import { runTest } from "../setup.js"

// Import the parsing functions we want to test
// Note: We'll need to extract these functions from index.ts to make them testable
import { 
  parseDocumentationPage, 
  parseSearchResults,
  parseHdkIndex 
} from "./test-utils.js"

describe("Content Parsing", () => {
  const fixturesPath = join(process.cwd(), "tests", "fixtures")
  
  describe("parseDocumentationPage", () => {
    it("should extract content from Holochain validation page", () => 
      runTest(Effect.gen(function* () {
        const html = readFileSync(join(fixturesPath, "holochain-validation-page.html"), "utf-8")
        const url = "https://developer.holochain.org/concepts/7_validation"
        
        const result = yield* parseDocumentationPage(html, url)
        
        expect(result.title).toBe("Validation: Assuring Data Integrity")
        expect(result.source).toBe("developer.holochain.org")
        expect(result.url).toBe(url)
        expect(result.content).toContain("Data validation rules are the core of a Holochain app")
        expect(result.content).toContain("distributed validation approach")
        expect(result.content).not.toContain("Navigation") // Should remove nav content
        expect(result.content).not.toContain("© 2024 Holochain Foundation") // Should remove footer
      }))
    )

    it("should extract content from HDK function page", () =>
      runTest(Effect.gen(function* () {
        const html = readFileSync(join(fixturesPath, "hdk-create-entry-page.html"), "utf-8")
        const url = "https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html"
        
        const result = yield* parseDocumentationPage(html, url)
        
        expect(result.title).toContain("create_entry")
        expect(result.source).toBe("docs.rs/hdk")
        expect(result.url).toBe(url)
        expect(result.content).toContain("Create an app entry")
        expect(result.content).toContain("entry def ids")
        expect(result.content).toContain("create_entry")
      }))
    )

    it("should handle empty content gracefully", () =>
      runTest(Effect.gen(function* () {
        const html = "<html><head><title>Empty</title></head><body></body></html>"
        const url = "https://example.com/empty"
        
        const result = yield* parseDocumentationPage(html, url)
        
        expect(result.title).toBe("Empty")
        expect(result.content).toBe("No content found.")
        expect(result.source).toBe("unknown")
      }))
    )
  })

  describe("parseSearchResults", () => {
    it("should find relevant content for search terms", () =>
      runTest(Effect.gen(function* () {
        const html = readFileSync(join(fixturesPath, "holochain-validation-page.html"), "utf-8")
        const url = "https://developer.holochain.org/concepts/7_validation" 
        const searchTerms = ["validation", "integrity"]
        
        const result = yield* parseSearchResults(html, url, searchTerms)
        
        if (result._tag === "Some") {
          expect(result.value.title).toBe("Validation: Assuring Data Integrity")
          expect(result.value.source).toBe("developer.holochain.org")
          expect(result.value.snippet.toLowerCase()).toContain("validation")
          expect(result.value.url).toBe(url)
        } else {
          throw new Error("Expected Some but got None")
        }
      }))
    )

    it("should return None for irrelevant content", () =>
      runTest(Effect.gen(function* () {
        const html = "<html><head><title>Unrelated</title></head><body><p>This is about cats</p></body></html>"
        const url = "https://example.com/cats"
        const searchTerms = ["validation", "holochain"]
        
        const result = yield* parseSearchResults(html, url, searchTerms)
        
        expect(result._tag).toBe("None")
      }))
    )
  })

  describe("parseHdkIndex", () => {
    it("should extract HDK functions from index page", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="entry/fn.create_entry.html">create_entry</a>
              <a href="entry/fn.get.html">get</a>
              <a href="link/fn.create_link.html">create_link</a>
              <a href="agent/fn.agent_info.html">agent_info</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const result = yield* parseHdkIndex(html, baseUrl)
        
        expect(result.length).toBeGreaterThan(0)
        
        const functionNames = result.map(f => f.name)
        expect(functionNames).toContain("create_entry")
        expect(functionNames).toContain("get")
        expect(functionNames).toContain("create_link")
        expect(functionNames).toContain("agent_info")
        
        const createEntryFunc = result.find(f => f.name === "create_entry")
        expect(createEntryFunc?.url).toBe("https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html")
      }))
    )

    it("should include common functions even if not found in HTML", () =>
      runTest(Effect.gen(function* () {
        const html = "<html><body></body></html>" // Empty HTML
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const result = yield* parseHdkIndex(html, baseUrl)
        
        expect(result.length).toBeGreaterThan(0)
        
        const functionNames = result.map(f => f.name)
        // Should still include common functions from our fallback
        expect(functionNames).toContain("create_entry")
        expect(functionNames).toContain("get_links") 
        expect(functionNames).toContain("agent_info")
      }))
    )
  })
})