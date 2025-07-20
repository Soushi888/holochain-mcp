import { Effect } from "effect"
import { describe, it, expect } from "vitest"
import { runTest } from "../setup.js"
import { parseHdkIndex } from "../unit/test-utils.js"

describe("HDK Function Lookup Failures (Real-World Issues)", () => {
  describe("URL Construction Problems", () => {
    it("should detect incorrect URL patterns that cause 404s", () =>
      runTest(Effect.gen(function* () {
        // Test the ACTUAL URL patterns found in manual testing
        const realHdkIndexHtml = `
          <html>
            <body>
              <!-- These are the REAL patterns from docs.rs -->
              <a href="entry/fn.create_entry.html">create_entry</a>
              <a href="link/fn.get_links.html">get_links</a>
              <a href="agent/fn.agent_info.html">agent_info</a>
              <a href="p2p/fn.call.html">call</a>
            </body>
          </html>
        `
        
        const functions = yield* parseHdkIndex(realHdkIndexHtml, "https://docs.rs/hdk/latest/hdk")
        
        // Check that URLs are constructed correctly
        const createEntry = functions.find(f => f.name === "create_entry")
        expect(createEntry?.url).toBe("https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html")
        
        const getLinks = functions.find(f => f.name === "get_links")
        expect(getLinks?.url).toBe("https://docs.rs/hdk/latest/hdk/link/fn.get_links.html")
        
        const agentInfo = functions.find(f => f.name === "agent_info")
        expect(agentInfo?.url).toBe("https://docs.rs/hdk/latest/hdk/agent/fn.agent_info.html")
        
        const call = functions.find(f => f.name === "call")
        expect(call?.url).toBe("https://docs.rs/hdk/latest/hdk/p2p/fn.call.html")
      }))
    )
    
    it("should handle the wrong URL pattern that causes failures", () =>
      runTest(Effect.gen(function* () {
        // This tests the WRONG pattern that our current code generates
        const functions = yield* parseHdkIndex("<html><body></body></html>", "https://docs.rs/hdk/latest/hdk")
        
        const createEntry = functions.find(f => f.name === "create_entry")
        
        // Current implementation generates this WRONG URL:
        // https://docs.rs/hdk/latest/hdk/fn.create_entry.html
        // But it SHOULD be:
        // https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html
        
        expect(createEntry?.url).not.toBe("https://docs.rs/hdk/latest/hdk/fn.create_entry.html") // Wrong pattern
        expect(createEntry?.url).toBe("https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html") // Correct pattern
      }))
    )
  })

  describe("Function Name Extraction Edge Cases", () => {
    it("should handle complex function names and module paths", () =>
      runTest(Effect.gen(function* () {
        const complexHtml = `
          <html>
            <body>
              <!-- Real patterns from docs.rs -->
              <a href="entry/fn.create_entry.html">hdk::entry::create_entry</a>
              <a href="link/fn.get_link_details.html">get_link_details</a>
              <a href="capability/fn.create_cap_grant.html">create_cap_grant</a>
              <a href="x_salsa20_poly1305/fn.encrypt.html">encrypt</a>
            </body>
          </html>
        `
        
        const functions = yield* parseHdkIndex(complexHtml, "https://docs.rs/hdk/latest/hdk")
        
        const names = functions.map(f => f.name)
        expect(names).toContain("create_entry")
        expect(names).toContain("get_link_details")
        expect(names).toContain("create_cap_grant")
        expect(names).toContain("encrypt")
        
        // Check URLs have correct module paths
        const encrypt = functions.find(f => f.name === "encrypt")
        expect(encrypt?.url).toContain("x_salsa20_poly1305/fn.encrypt.html")
      }))
    )
    
    it("should detect when function lookup will fail due to missing module info", () =>
      runTest(Effect.gen(function* () {
        // Test functions that exist but might not be in our fallback list
        const functions = yield* parseHdkIndex("<html><body></body></html>", "https://docs.rs/hdk/latest/hdk")
        
        // These should all be in our fallback, but let's verify
        const criticalFunctions = ["create_entry", "get_links", "agent_info", "call", "hash"]
        
        criticalFunctions.forEach(funcName => {
          const found = functions.find(f => f.name === funcName)
          expect(found, `Critical function ${funcName} should be in fallback list`).toBeDefined()
        })
      }))
    )
  })

  describe("Module-Specific URL Patterns", () => {
    it("should correctly map functions to their modules", () =>
      runTest(Effect.gen(function* () {
        const functions = yield* parseHdkIndex("<html><body></body></html>", "https://docs.rs/hdk/latest/hdk")
        
        // Verify module mappings are correct
        const entryFunctions = functions.filter(f => f.url.includes("/entry/"))
        expect(entryFunctions.map(f => f.name)).toContain("create_entry")
        expect(entryFunctions.map(f => f.name)).toContain("get")
        expect(entryFunctions.map(f => f.name)).toContain("update_entry")
        
        const linkFunctions = functions.filter(f => f.url.includes("/link/"))
        expect(linkFunctions.map(f => f.name)).toContain("create_link")
        expect(linkFunctions.map(f => f.name)).toContain("get_links")
        
        const p2pFunctions = functions.filter(f => f.url.includes("/p2p/"))
        expect(p2pFunctions.map(f => f.name)).toContain("call")
        expect(p2pFunctions.map(f => f.name)).toContain("call_remote")
      }))
    )
  })

  describe("Error Patterns from Manual Testing", () => {
    it("should detect the specific errors found in manual testing", () =>
      runTest(Effect.gen(function* () {
        // These are the exact function names that failed in manual testing
        const failedFunctions = [
          "create_entry",
          "get_links", 
          "agent_info",
          "call",
          "hash"
        ]
        
        const functions = yield* parseHdkIndex("<html><body></body></html>", "https://docs.rs/hdk/latest/hdk")
        
        failedFunctions.forEach(funcName => {
          const func = functions.find(f => f.name === funcName)
          expect(func, `Function ${funcName} should be available`).toBeDefined()
          
          if (func) {
            // Verify the URL follows the correct pattern with module path
            expect(func.url).not.toMatch(/\/hdk\/fn\.[^/]+\.html$/) // Should not be directly under /hdk/
            expect(func.url).toMatch(/\/[^/]+\/fn\.[^/]+\.html$/) // Should have module path like entry/fn.create_entry.html
          }
        })
      }))
    )
  })
})