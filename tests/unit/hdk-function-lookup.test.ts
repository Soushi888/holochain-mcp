import { Effect } from "effect"
import { describe, it, expect } from "vitest"
import { runTest } from "../setup.js"
import { parseHdkIndex } from "./test-utils.js"

describe("HDK Function Lookup", () => {
  describe("URL Construction", () => {
    it("should construct correct URLs for module-based functions", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="entry/fn.create_entry.html">create_entry</a>
              <a href="link/fn.get_links.html">get_links</a>
              <a href="agent/fn.agent_info.html">agent_info</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        const createEntry = functions.find(f => f.name === "create_entry")
        expect(createEntry).toBeDefined()
        expect(createEntry?.url).toBe("https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html")
        
        const getLinks = functions.find(f => f.name === "get_links")
        expect(getLinks).toBeDefined()
        expect(getLinks?.url).toBe("https://docs.rs/hdk/latest/hdk/link/fn.get_links.html")
      }))
    )
    
    it("should handle absolute URLs correctly", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html">create_entry</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        const createEntry = functions.find(f => f.name === "create_entry")
        expect(createEntry?.url).toBe("https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html")
      }))
    )
    
    it("should handle root-relative URLs correctly", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="/hdk/latest/hdk/entry/fn.create_entry.html">create_entry</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        const createEntry = functions.find(f => f.name === "create_entry")
        expect(createEntry?.url).toBe("https://docs.rs/hdk/latest/hdk/entry/fn.create_entry.html")
      }))
    )
  })

  describe("Function Name Extraction", () => {
    it("should extract function names from href patterns", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="entry/fn.create_entry.html">Some Link Text</a>
              <a href="link/fn.get_links.html">crate::link::get_links</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        expect(functions.map(f => f.name)).toContain("create_entry")
        expect(functions.map(f => f.name)).toContain("get_links")
      }))
    )
    
    it("should extract function names from module paths", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="entry/fn.update_entry.html">crate::entry::update_entry</a>
              <a href="p2p/fn.call_remote.html">hdk::p2p::call_remote</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        expect(functions.map(f => f.name)).toContain("update_entry")
        expect(functions.map(f => f.name)).toContain("call_remote")
      }))
    )
    
    it("should filter out invalid function names", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="entry/fn.create_entry.html">create_entry</a>
              <a href="invalid.html">Invalid Link</a>
              <a href="entry/fn.123invalid.html">123invalid</a>
              <a href="entry/fn.valid_function.html">valid_function</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        const names = functions.map(f => f.name)
        expect(names).toContain("create_entry")
        expect(names).toContain("valid_function")
        expect(names).not.toContain("Invalid Link")
        expect(names).not.toContain("123invalid")
      }))
    )
  })

  describe("Fallback Functions", () => {
    it("should include common functions even when HTML is empty", () =>
      runTest(Effect.gen(function* () {
        const html = "<html><body></body></html>"
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        const names = functions.map(f => f.name)
        
        // Should include functions from all major modules
        expect(names).toContain("create_entry")
        expect(names).toContain("get")
        expect(names).toContain("create_link")
        expect(names).toContain("get_links")
        expect(names).toContain("agent_info")
        expect(names).toContain("call")
        expect(names).toContain("hash")
      }))
    )
    
    it("should not duplicate functions found in both HTML and fallback", () =>
      runTest(Effect.gen(function* () {
        const html = `
          <html>
            <body>
              <a href="entry/fn.create_entry.html">create_entry</a>
              <a href="link/fn.get_links.html">get_links</a>
            </body>
          </html>
        `
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        const createEntryFunctions = functions.filter(f => f.name === "create_entry")
        const getLinksFunctions = functions.filter(f => f.name === "get_links")
        
        expect(createEntryFunctions).toHaveLength(1)
        expect(getLinksFunctions).toHaveLength(1)
      }))
    )
  })

  describe("Module Organization", () => {
    it("should organize functions by module correctly", () =>
      runTest(Effect.gen(function* () {
        const html = "<html><body></body></html>" // Use fallback
        const baseUrl = "https://docs.rs/hdk/latest/hdk"
        
        const functions = yield* parseHdkIndex(html, baseUrl)
        
        // Check entry module functions
        const entryFunctions = functions.filter(f => f.url.includes("/entry/"))
        expect(entryFunctions.map(f => f.name)).toContain("create_entry")
        expect(entryFunctions.map(f => f.name)).toContain("get")
        expect(entryFunctions.map(f => f.name)).toContain("update_entry")
        
        // Check link module functions  
        const linkFunctions = functions.filter(f => f.url.includes("/link/"))
        expect(linkFunctions.map(f => f.name)).toContain("create_link")
        expect(linkFunctions.map(f => f.name)).toContain("get_links")
        
        // Check agent module functions
        const agentFunctions = functions.filter(f => f.url.includes("/agent/"))
        expect(agentFunctions.map(f => f.name)).toContain("agent_info")
      }))
    )
  })
})