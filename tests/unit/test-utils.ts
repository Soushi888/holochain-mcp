import { Effect, Option } from "effect"
import * as cheerio from "cheerio"

// Error types for testing
export class ParseError extends Error {
  readonly _tag = "ParseError"
  constructor(public override message: string) {
    super(message)
  }
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

export interface DocumentationResult {
  title: string
  content: string
  url: string
  source: string
}

export interface HdkFunction {
  name: string
  url: string
}

// Extract the parsing logic from index.ts for testing
export const parseDocumentationPage = (
  html: string,
  url: string
): Effect.Effect<DocumentationResult, ParseError> =>
  Effect.try({
    try: () => {
      const $ = cheerio.load(html)

      if (url.includes("developer.holochain.org")) {
        // Improved content extraction for developer.holochain.org
        let content = ""
        let title = ""
        
        // Try multiple selectors for content (prioritize .main-area)
        const contentSelectors = [
          ".main-area",
          "article",
          ".content",
          ".main-content",
          "main",
          "[role='main']",
        ]
        
        for (const selector of contentSelectors) {
          const element = $(selector)
          if (element.length > 0) {
            // Remove navigation, header, footer elements
            element
              .find("nav, header, footer, .nav, .header, .footer, .menu, .sidebar")
              .remove()
            content = element.text().trim()
            if (content.length > 100) break // Good content found
          }
        }
        
        // Fallback to body content with cleanup
        if (!content || content.length < 100) {
          const bodyContent = $("body").clone()
          bodyContent
            .find("nav, header, footer, script, style, .nav, .header, .footer, .menu, .sidebar")
            .remove()
          content = bodyContent.text().trim()
        }
        
        // Extract title
        title = $("h1").first().text() || $("title").text() || ""
        
        // Clean up content - remove extra whitespace and common navigation text
        content = content
          .replace(/\s+/g, " ")
          .replace(/Get Started|Developers|Navigation|Menu|Search/gi, "")
          .trim()

        return {
          title: title.trim(),
          content: content || "No content found.",
          url,
          source: "developer.holochain.org",
        }
      }

      if (url.includes("docs.rs")) {
        // Improved content extraction for docs.rs
        let title = ""
        let content = ""
        
        // Extract title - try multiple selectors
        title = $(".fqn").text() || 
               $("h1.fqn").text() || 
               $("h1").first().text() || 
               $("title").text() || ""
        
        // Extract documentation content
        const docblocks = $(".docblock")
        if (docblocks.length > 0) {
          content = docblocks
            .map((_, el) => $(el).text().trim())
            .get()
            .filter(text => text.length > 0)
            .join("\n\n")
        }
        
        // If no docblocks, try other selectors
        if (!content) {
          const contentSelectors = [
            ".item-info",
            ".content",
            "main",
            ".main-content",
          ]
          
          for (const selector of contentSelectors) {
            const element = $(selector)
            if (element.length > 0) {
              element.find("nav, .nav, .sidebar").remove()
              content = element.text().trim()
              if (content.length > 50) break
            }
          }
        }
        
        // Clean title and content
        title = title.replace(/^(pub\s+)?(fn\s+)?/, "").trim()
        content = content.replace(/\s+/g, " ").trim()
        
        return {
          title: title || "Documentation",
          content: content || "No documentation content found.",
          url,
          source: url.includes("/hdk/") ? "docs.rs/hdk" : "docs.rs/hdi",
        }
      }

      // Default case
      return {
        title: $("title").text() || "Unknown",
        content: $("body").text().replace(/\s+/g, " ").trim() || "No content found.",
        url,
        source: "unknown",
      }
    },
    catch: (error) => new ParseError(`Failed to parse documentation page: ${error}`),
  })

export const parseSearchResults = (
  html: string,
  url: string,
  searchTerms: string[]
): Effect.Effect<Option.Option<SearchResult>, ParseError> =>
  Effect.try({
    try: () => {
      const $ = cheerio.load(html)
      const title = $("title").text() || $("h1").first().text() || url
      const content = $("body").text().toLowerCase()

      // Calculate relevance score
      const relevanceScore = searchTerms.reduce((score, term) => {
        const matches = (content.match(new RegExp(term, "gi")) || []).length
        return score + matches
      }, 0)

      if (relevanceScore === 0) {
        return Option.none()
      }

      const firstTerm = searchTerms.find((term) => content.includes(term))
      if (!firstTerm) {
        return Option.none()
      }

      // Extract snippet around first match
      const index = content.indexOf(firstTerm)
      const start = Math.max(0, index - 100)
      const end = Math.min(content.length, index + 200)
      const snippet = html
        .substring(start, end)
        .replace(/<[^>]*>/g, "")
        .trim()

      const source = url.includes("developer.holochain.org")
        ? "developer.holochain.org"
        : url.includes("/hdk/")
        ? "docs.rs/hdk"
        : "docs.rs/hdi"

      return Option.some({
        title: title.trim(),
        url,
        snippet,
        source,
      })
    },
    catch: (error) => new ParseError(`Failed to parse search results: ${error}`),
  })

export const parseHdkIndex = (
  html: string,
  baseUrl: string
): Effect.Effect<HdkFunction[], ParseError> =>
  Effect.try({
    try: () => {
      const $ = cheerio.load(html)
      const functions: HdkFunction[] = []
      const seenFunctions = new Set<string>()

      // Look for function links in different patterns
      const functionSelectors = [
        "a[href*='/fn.']",  // Direct function links
        "a[href*='fn.']",   // Relative function links
        "a[href*='function']", // Alternative function link pattern
        ".item-name a"       // Item name links that might be functions
      ]

      functionSelectors.forEach(selector => {
        $(selector).each((_, el) => {
          const href = $(el).attr("href")
          const text = $(el).text().trim()

          if (href && text && (href.includes('fn.') || text.match(/^[a-z_][a-z0-9_]*$/))) {
            // Extract function name from either the text or the href
            let functionName = text

            // Extract from href if text doesn't look like a function name
            if (!functionName.match(/^[a-z_][a-z0-9_]*$/) && href.includes('fn.')) {
              const match = href.match(/fn\.([^.]+)/)
              if (match && match[1]) {
                functionName = match[1]
              }
            }

            // If the text looks like a module path (e.g., "crate::entry::create_entry"),
            // extract just the function name
            if (functionName.includes("::")) {
              functionName = functionName.split("::").pop() || functionName
            }

            // Only add if it looks like a valid function name and we haven't seen it
            if (functionName.match(/^[a-z_][a-z0-9_]*$/) && !seenFunctions.has(functionName)) {
              seenFunctions.add(functionName)
              
              // Construct proper URL
              let functionUrl
              if (href.startsWith('http')) {
                functionUrl = href
              } else if (href.startsWith('/')) {
                functionUrl = `https://docs.rs${href}`
              } else {
                functionUrl = `${baseUrl}/${href}`
              }

              functions.push({
                name: functionName,
                url: functionUrl
              })
            }
          }
        })
      })

      // Also look for module-based functions by exploring module pages
      const modules = ['entry', 'link', 'agent', 'chain', 'p2p', 'capability', 'hash', 'info']
      modules.forEach(module => {
        // Add common functions we know exist in each module
        const commonFunctions: Record<string, string[]> = {
          entry: ['create_entry', 'get', 'update_entry', 'delete_entry'],
          link: ['create_link', 'get_links', 'delete_link', 'get_link_details'],
          agent: ['agent_info'],
          chain: ['get_chain_head', 'query'],
          p2p: ['call', 'call_remote', 'emit_signal'],
          capability: ['create_cap_grant', 'create_cap_claim'],
          hash: ['hash'],
          info: ['dna_info', 'zome_info', 'call_info']
        }

        if (commonFunctions[module]) {
          commonFunctions[module].forEach(funcName => {
            if (!seenFunctions.has(funcName)) {
              seenFunctions.add(funcName)
              functions.push({
                name: funcName,
                url: `${baseUrl}/${module}/fn.${funcName}.html`
              })
            }
          })
        }
      })

      return functions
    },
    catch: (error) => new ParseError(`Failed to parse HDK index: ${error}`),
  })