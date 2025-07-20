#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { Effect, Context, Layer, pipe, Array, Option, Match, Console, Schema, Order, Runtime, Scope, Exit, } from "effect";
import { z } from "zod";
import { HttpClient, HttpClientRequest, HttpClientResponse, } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import puppeteer from "puppeteer";
import Fuse from "fuse.js";
// ==== Schemas ====
const SearchResultSchema = Schema.Struct({
    title: Schema.String,
    url: Schema.String,
    snippet: Schema.String,
    source: Schema.String,
});
const DocumentationResultSchema = Schema.Struct({
    title: Schema.String,
    content: Schema.String,
    url: Schema.String,
    source: Schema.String,
});
const SearchInputSchema = Schema.Struct({
    query: Schema.String,
    source: Schema.optional(Schema.Literal("all", "developer", "hdk", "hdi")),
});
const FetchInputSchema = Schema.Struct({
    url: Schema.String,
});
const FunctionInputSchema = Schema.Struct({
    functionName: Schema.String,
});
const ConceptInputSchema = Schema.Struct({
    concept: Schema.String,
});
const HdkFunctionSchema = Schema.Struct({
    name: Schema.String,
    url: Schema.String,
});
// ==== Error Types ====
class FetchError extends Schema.TaggedError()("FetchError", {
    message: Schema.String,
}) {
}
class ParseError extends Schema.TaggedError()("ParseError", {
    message: Schema.String,
}) {
}
class NotFoundError extends Schema.TaggedError()("NotFoundError", {
    message: Schema.String,
}) {
}
const HolochainConfigService = Context.GenericTag("HolochainConfig");
const HolochainConfigLive = Layer.succeed(HolochainConfigService, {
    baseUrls: {
        developer: "https://developer.holochain.org",
        hdk: "https://docs.rs/hdk/latest/hdk",
        hdi: "https://docs.rs/hdi/latest/hdi",
    },
    timeout: 10000,
    userAgent: "Holochain-MCP-Server/1.0.0",
});
const HttpServiceTag = Context.GenericTag("HttpService");
// Simple in-memory cache
const pageCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const HttpServiceLive = Layer.scoped(HttpServiceTag, Effect.gen(function* () {
    const config = yield* HolochainConfigService;
    const httpClient = yield* HttpClient.HttpClient;
    const browser = yield* Effect.acquireRelease(Effect.tryPromise({
        try: () => puppeteer.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
            ],
        }),
        catch: (e) => new FetchError({ message: `Puppeteer launch failed: ${e}` }),
    }), (browser) => Effect.promise(() => browser.close()));
    const fetchPage = (url) => {
        // Check cache first - but validate cached content quality
        const cached = pageCache.get(url);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            // Validate cached content is still good quality
            const isGoodCache = cached.content.trim().length > 100 &&
                !cached.content.includes("404") &&
                !cached.content.includes("Not Found") &&
                !cached.content.includes("Error");
            if (isGoodCache) {
                console.error(`Cache hit for ${url}`);
                return Effect.succeed(cached.content);
            }
            else {
                // Remove bad cached content and refetch
                pageCache.delete(url);
                console.error(`Removing bad cached content for ${url}`);
            }
        }
        const fetchAndCache = (content) => {
            // Only cache if content is meaningful (not empty and has substantial content)
            const shouldCache = content.trim().length > 100 &&
                !content.includes("404") &&
                !content.includes("Not Found") &&
                !content.includes("Error");
            if (shouldCache) {
                pageCache.set(url, { content, timestamp: Date.now() });
                // Clean old cache entries
                if (pageCache.size > 100) {
                    const cutoff = Date.now() - CACHE_TTL;
                    for (const [key, value] of pageCache.entries()) {
                        if (value.timestamp < cutoff) {
                            pageCache.delete(key);
                        }
                    }
                }
            }
            else {
                // Remove any existing bad cache entry for this URL
                pageCache.delete(url);
                console.error(`Not caching low-quality content for ${url}: ${content.length} chars`);
            }
            return content;
        };
        if (url.includes("developer.holochain.org")) {
            return Effect.tryPromise({
                try: async () => {
                    const page = await browser.newPage();
                    try {
                        // Set a reasonable timeout and wait strategy
                        await page.goto(url, {
                            waitUntil: "domcontentloaded", // Changed from networkidle2 for better performance
                            timeout: Math.min(config.timeout, 15000), // Cap at 15s
                        });
                        const content = await page.content();
                        return fetchAndCache(content);
                    }
                    finally {
                        await page.close();
                    }
                },
                catch: (error) => new FetchError({
                    message: `Puppeteer fetch failed for ${url}: ${error}`,
                }),
            }).pipe(Effect.timeout(18000), // Reduced timeout
            Effect.mapError(() => new FetchError({
                message: `Timeout fetching with puppeteer: ${url}`,
            })));
        }
        return pipe(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({
            "User-Agent": config.userAgent,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate",
            Connection: "keep-alive",
        })), httpClient.execute, Effect.flatMap((response) => response.text), Effect.map(fetchAndCache), Effect.mapError(() => new FetchError({ message: `Failed to fetch: ${url}` })), Effect.timeout(Math.min(config.timeout, 10000)), // Cap timeout at 10s
        Effect.mapError(() => new FetchError({ message: `Timeout fetching: ${url}` })));
    };
    return { fetchPage };
})).pipe(Layer.provide(NodeHttpClient.layer));
const DocumentationParserTag = Context.GenericTag("DocumentationParser");
const DocumentationParserLive = Layer.succeed(DocumentationParserTag, {
    parseSearchResults: (html, url, searchTerms) => Effect.try({
        try: () => {
            const $ = cheerio.load(html);
            const title = $("title").text() || $("h1").first().text() || url;
            const content = $("body").text().toLowerCase();
            // Calculate relevance score
            const relevanceScore = searchTerms.reduce((score, term) => {
                const matches = (content.match(new RegExp(term, "gi")) || []).length;
                return score + matches;
            }, 0);
            if (relevanceScore === 0) {
                return Option.none();
            }
            const firstTerm = searchTerms.find((term) => content.includes(term));
            if (!firstTerm) {
                return Option.none();
            }
            // Extract snippet around first match, but use body text instead of raw HTML
            const bodyText = $("body").text();
            const index = bodyText.toLowerCase().indexOf(firstTerm);
            const start = Math.max(0, index - 100);
            const end = Math.min(bodyText.length, index + 200);
            let snippet = bodyText.substring(start, end).trim();
            // Clean up snippet - remove common HTML metadata patterns
            snippet = snippet
                .replace(/Circle with shading containing.*?statistic/gi, "")
                .replace(/YouTube play video icon.*?logo/gi, "")
                .replace(/Edge_Logo_\d+x\d+/gi, "")
                .replace(/\s+/g, " ")
                .trim();
            // If snippet is too short or contains metadata, try extracting from main content areas
            if (snippet.length < 50 || snippet.includes("Circle with shading")) {
                const mainContentSelectors = [
                    ".main-area",
                    "article",
                    ".content",
                    ".main-content",
                    "main",
                    "[role='main']",
                    "div[class*='content']",
                    "div[class*='main']",
                    "body > div",
                ];
                for (const selector of mainContentSelectors) {
                    const mainContent = $(selector).text().trim();
                    if (mainContent && mainContent.length > snippet.length) {
                        const mainIndex = mainContent.toLowerCase().indexOf(firstTerm);
                        if (mainIndex >= 0) {
                            const mainStart = Math.max(0, mainIndex - 100);
                            const mainEnd = Math.min(mainContent.length, mainIndex + 200);
                            const candidateSnippet = mainContent
                                .substring(mainStart, mainEnd)
                                .trim();
                            // Clean up candidate snippet
                            const cleanSnippet = candidateSnippet
                                .replace(/Circle with shading containing.*?statistic/gi, "")
                                .replace(/YouTube play video icon.*?logo/gi, "")
                                .replace(/Edge_Logo_\d+x\d+/gi, "")
                                .replace(/Navigation|Menu|Header|Footer/gi, "")
                                .replace(/\s+/g, " ")
                                .trim();
                            if (cleanSnippet.length > snippet.length) {
                                snippet = cleanSnippet;
                                break;
                            }
                        }
                    }
                }
            }
            const source = url.includes("developer.holochain.org")
                ? "developer.holochain.org"
                : url.includes("/hdk/")
                    ? "docs.rs/hdk"
                    : "docs.rs/hdi";
            return Option.some({
                title: title.trim(),
                url,
                snippet,
                source,
            });
        },
        catch: (error) => new ParseError({ message: `Failed to parse search results: ${error}` }),
    }),
    parseDocumentationPage: (html, url) => Effect.try({
        try: () => {
            const $ = cheerio.load(html);
            const result = pipe(url, Match.value, Match.when((url) => url.includes("developer.holochain.org"), () => {
                // Improved content extraction for developer.holochain.org
                let content = "";
                let title = "";
                // Try multiple selectors for content with comprehensive fallbacks
                const contentSelectors = [
                    ".main-area",
                    "article",
                    ".content",
                    ".main-content",
                    "main",
                    "[role='main']",
                    ".container .content",
                    ".page-content",
                    ".documentation",
                    ".docs-content",
                    // More generic selectors as fallbacks
                    "div[class*='content']",
                    "div[class*='main']",
                    "div[id*='content']",
                    "div[id*='main']",
                    // Last resort: any div with substantial text content
                    "body > div",
                ];
                for (const selector of contentSelectors) {
                    const elements = $(selector);
                    if (elements.length > 0) {
                        // For each matching element, test content quality
                        elements.each((_, element) => {
                            const $element = $(element);
                            // Remove navigation, header, footer elements from a clone
                            const cleanElement = $element.clone();
                            cleanElement
                                .find("nav, header, footer, script, style, .nav, .header, .footer, .menu, .sidebar, .navigation")
                                .remove();
                            const candidateContent = cleanElement.text().trim();
                            // Score content quality: longer content with relevant keywords scores higher
                            const hasRelevantContent = candidateContent.toLowerCase().includes("holochain") ||
                                candidateContent.toLowerCase().includes("validation") ||
                                candidateContent.toLowerCase().includes("dht") ||
                                candidateContent.toLowerCase().includes("entry") ||
                                candidateContent.toLowerCase().includes("link");
                            const contentScore = candidateContent.length + (hasRelevantContent ? 500 : 0);
                            // Use this content if it's better than what we have
                            if (contentScore > content.length + 100) {
                                // Require significant improvement
                                content = candidateContent;
                            }
                        });
                        if (content.length > 100)
                            break; // Good content found
                    }
                }
                // Fallback to body content with cleanup
                if (!content || content.length < 100) {
                    const bodyContent = $("body").clone();
                    bodyContent
                        .find("nav, header, footer, script, style, .nav, .header, .footer, .menu, .sidebar")
                        .remove();
                    content = bodyContent.text().trim();
                }
                // Extract title - prefer title tag for page titles
                title =
                    $("title").text().trim() || $("h1").first().text().trim() || "";
                // Clean up content - remove extra whitespace and common navigation text
                content = content
                    .replace(/\s+/g, " ")
                    .replace(/Get Started|Developers|Navigation|Menu|Search|Home|Back to top|Skip to|Table of contents/gi, "")
                    .replace(/Circle with shading containing.*?statistic/gi, "")
                    .replace(/YouTube play video icon.*?logo/gi, "")
                    .replace(/Edge_Logo_\d+x\d+/gi, "")
                    .replace(/^\s*(Navigation|Menu|Header|Footer)\s*/gi, "")
                    .trim();
                return {
                    title: title.trim(),
                    content: content || "Error: Could not extract main content.",
                    source: "developer.holochain.org",
                };
            }), Match.when((url) => url.includes("docs.rs"), () => {
                // Improved content extraction for docs.rs
                let title = "";
                let content = "";
                // Extract title - try multiple selectors
                title =
                    $(".fqn").text() ||
                        $("h1.fqn").text() ||
                        $("h1").first().text() ||
                        $("title").text() ||
                        "";
                // Extract documentation content
                const docblocks = $(".docblock");
                if (docblocks.length > 0) {
                    content = docblocks
                        .map((_, el) => $(el).text().trim())
                        .get()
                        .filter((text) => text.length > 0)
                        .join("\n\n");
                }
                // If no docblocks, try other selectors including function signatures
                if (!content) {
                    const contentSelectors = [
                        ".item-info",
                        ".item-decl", // Function signatures
                        ".content",
                        "main",
                        ".main-content",
                    ];
                    for (const selector of contentSelectors) {
                        const element = $(selector);
                        if (element.length > 0) {
                            element.find("nav, .nav, .sidebar").remove();
                            content = element.text().trim();
                            if (content.length > 20)
                                break; // Lower threshold for signatures
                        }
                    }
                }
                // Always try to extract function signature from .fqn and include it
                const fqnContent = $(".fqn").text().trim();
                if (fqnContent) {
                    if (!content || content.length < 50) {
                        content = `Function signature: ${fqnContent}\n\n${content || "No additional documentation available."}`;
                    }
                    else if (!content.toLowerCase().includes("externresult") &&
                        !content.includes(fqnContent)) {
                        // Prepend signature if not already included and doesn't have signature content
                        content = `Function signature: ${fqnContent}\n\n${content}`;
                    }
                }
                // If still no meaningful content, also try body content as last resort
                if (!content || content.length < 50) {
                    const bodyContent = $("body").text().trim();
                    if (bodyContent && bodyContent.length > content.length) {
                        content = bodyContent;
                    }
                }
                // Clean title and content
                title = title.replace(/^(pub\s+)?(fn\s+)?/, "").trim();
                content = content.replace(/\s+/g, " ").trim();
                return {
                    title: title || "Documentation",
                    content: content.length > 0
                        ? content
                        : "No documentation content found.",
                    source: url.includes("/hdk/") ? "docs.rs/hdk" : "docs.rs/hdi",
                };
            }), Match.orElse(() => ({
                title: $("title").text() || "Unknown",
                content: $("body").text().replace(/\s+/g, " ").trim() ||
                    "No content found.",
                source: "unknown",
            })));
            return {
                title: result.title.trim(),
                content: result.content.trim(),
                url,
                source: result.source,
            };
        },
        catch: (error) => new ParseError({
            message: `Failed to parse documentation page: ${error}`,
        }),
    }),
    parseHdkIndex: (html, baseUrl) => Effect.try({
        try: () => {
            const $ = cheerio.load(html);
            const functions = [];
            const seenFunctions = new Set();
            // Enhanced function discovery with multiple strategies
            // Strategy 1: Look for direct function links
            const functionSelectors = [
                "a[href*='/fn.']", // Direct function links
                "a[href*='fn.']", // Relative function links
                ".item-name a", // Item name links
                ".module-item a", // Module item links
            ];
            functionSelectors.forEach((selector) => {
                $(selector).each((_, el) => {
                    const href = $(el).attr("href");
                    const text = $(el).text().trim();
                    if (href && href.includes("fn.")) {
                        const match = href.match(/fn\.([^.\/]+)\.html/);
                        if (match && match[1]) {
                            const functionName = match[1];
                            if (!seenFunctions.has(functionName)) {
                                seenFunctions.add(functionName);
                                // Construct proper URL
                                let functionUrl;
                                if (href.startsWith("http")) {
                                    functionUrl = href;
                                }
                                else if (href.startsWith("/")) {
                                    functionUrl = `https://docs.rs${href}`;
                                }
                                else {
                                    functionUrl = `${baseUrl}/${href}`;
                                }
                                functions.push({
                                    name: functionName,
                                    url: functionUrl,
                                });
                            }
                        }
                    }
                });
            });
            // Strategy 2: Look for module links and explore them
            const moduleLinks = new Set();
            $("a[href*='/index.html'], a[href$='/']").each((_, el) => {
                const href = $(el).attr("href");
                if (href && !href.includes("../")) {
                    if (href.startsWith("/")) {
                        moduleLinks.add(`https://docs.rs${href}`);
                    }
                    else {
                        moduleLinks.add(`${baseUrl}/${href}`);
                    }
                }
            });
            console.error(`Found ${moduleLinks.size} potential module links to explore`);
            // Strategy 3: Also look for any text patterns that look like function names
            // in the context of the page that might indicate available functions
            const textContent = $("body").text();
            const functionNamePattern = /\b([a-z_][a-z0-9_]*)\s*\(/g;
            let match;
            const potentialFunctions = new Set();
            while ((match = functionNamePattern.exec(textContent)) !== null) {
                const funcName = match[1];
                if (funcName &&
                    funcName.length > 2 &&
                    funcName.length < 30 &&
                    !funcName.includes("__")) {
                    potentialFunctions.add(funcName);
                }
            }
            console.error(`Found ${potentialFunctions.size} potential function names in text`);
            // Also look for module-based functions by exploring module pages
            const modules = [
                "entry",
                "link",
                "agent",
                "chain",
                "p2p",
                "capability",
                "hash",
                "info",
            ];
            modules.forEach((module) => {
                // Add common functions we know exist in each module
                const commonFunctions = {
                    entry: ["create_entry", "get", "update_entry", "delete_entry"],
                    link: [
                        "create_link",
                        "get_links",
                        "delete_link",
                        "get_link_details",
                    ],
                    agent: ["agent_info"],
                    chain: ["get_chain_head", "query"],
                    p2p: ["call", "call_remote", "emit_signal"],
                    capability: ["create_cap_grant", "create_cap_claim"],
                    hash: ["hash"],
                    info: ["dna_info", "zome_info", "call_info"],
                };
                if (commonFunctions[module]) {
                    commonFunctions[module].forEach((funcName) => {
                        if (!seenFunctions.has(funcName)) {
                            seenFunctions.add(funcName);
                            functions.push({
                                name: funcName,
                                url: `${baseUrl}/${module}/fn.${funcName}.html`,
                            });
                        }
                    });
                }
            });
            console.error(`Found ${functions.length} HDK functions:`, functions.map((f) => f.name).slice(0, 10));
            return functions;
        },
        catch: (error) => new ParseError({ message: `Failed to parse HDK index: ${error}` }),
    }),
});
const HolochainDocServiceTag = Context.GenericTag("HolochainDocService");
const HolochainDocServiceLive = Layer.effect(HolochainDocServiceTag, Effect.gen(function* () {
    const config = yield* HolochainConfigService;
    const httpService = yield* HttpServiceTag;
    const parser = yield* DocumentationParserTag;
    const commonDeveloperPages = [
        "/get-started",
        "/concepts/1_the_basics",
        "/concepts/2_application_architecture",
        "/concepts/3_source_chain",
        "/concepts/4_dht",
        "/concepts/5_links_anchors",
        "/concepts/6_zome_functions",
        "/concepts/7_validation",
        "/build",
        "/resources",
    ];
    const commonHDKPaths = [
        "/entry/index.html",
        "/link/index.html",
        "/agent/index.html",
        "/chain/index.html",
        "/capability/index.html",
        "/ed25519/index.html",
        "/hash/index.html",
        "/info/index.html",
        "/p2p/index.html",
        "/random/index.html",
        "/time/index.html",
        "/x_salsa20_poly1305/index.html",
    ];
    const commonHDIPaths = [
        "/entry/index.html",
        "/link/index.html",
        "/hash/index.html",
        "/holo_hash/index.html",
        "/map/index.html",
        "/prelude/index.html",
    ];
    const searchDeveloperDocs = (query) => pipe(commonDeveloperPages, Array.map((page) => `${config.baseUrls.developer}${page}`), Array.map((url) => pipe(httpService.fetchPage(url), Effect.flatMap((html) => parser.parseSearchResults(html, url, query.toLowerCase().split(" "))), Effect.map(Option.toArray), Effect.catchAll(() => Effect.succeed([])))), Effect.all, Effect.map(Array.flatten), Effect.map((results) => pipe(results, Array.sortBy(Order.mapInput(Order.number, (r) => -r.snippet.length)), Array.take(5))));
    const searchRustDocs = (query, docType) => {
        const paths = docType === "hdk" ? commonHDKPaths : commonHDIPaths;
        const baseUrl = config.baseUrls[docType];
        return pipe(paths, Array.map((path) => `${baseUrl}${path}`), Array.map((url) => pipe(httpService.fetchPage(url), Effect.flatMap((html) => parser.parseSearchResults(html, url, query.toLowerCase().split(" "))), Effect.map(Option.toArray), Effect.catchAll(() => Effect.succeed([])))), Effect.all, Effect.map(Array.flatten), Effect.map((results) => pipe(results, Array.sortBy(Order.mapInput(Order.number, (r) => -r.snippet.length)), Array.take(5))));
    };
    const fetchDocumentationPage = (url) => pipe(httpService.fetchPage(url), Effect.flatMap((html) => parser.parseDocumentationPage(html, url)), Effect.mapError((error) => error._tag === "FetchError"
        ? new NotFoundError({
            message: `Documentation page not found: ${url}`,
        })
        : error));
    // Dynamic HDK function discovery with caching
    const hdkFunctionCache = new Map();
    const FUNCTION_CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const discoverHDKFunctions = () => {
        // Check cache first
        const cached = hdkFunctionCache.get("hdk_functions");
        if (cached && Date.now() - cached.timestamp < FUNCTION_CACHE_TTL) {
            console.error(`HDK function cache hit: ${cached.functions.length} functions`);
            return Effect.succeed(cached.functions);
        }
        return pipe(httpService.fetchPage(`${config.baseUrls.hdk}/index.html`), Effect.flatMap((html) => parser.parseHdkIndex(html, config.baseUrls.hdk)), Effect.tap((functions) => {
            // Cache the discovered functions
            hdkFunctionCache.set("hdk_functions", {
                functions,
                timestamp: Date.now(),
            });
            console.error(`Discovered and cached ${functions.length} HDK functions`);
            return Effect.succeed(undefined);
        }), Effect.catchAll((error) => {
            console.error("Failed to discover HDK functions, using fallback discovery");
            return discoverHDKFunctionsFallback();
        }));
    };
    const discoverHDKFunctionsFallback = () => {
        // Fallback: crawl known module pages to discover functions
        const knownModules = [
            "entry",
            "link",
            "agent",
            "chain",
            "p2p",
            "capability",
            "ed25519",
            "hash",
            "info",
            "time",
            "random",
            "x_salsa20_poly1305",
        ];
        return pipe(knownModules, Array.map((module) => pipe(httpService.fetchPage(`${config.baseUrls.hdk}/${module}/index.html`), Effect.flatMap((html) => Effect.try({
            try: () => {
                const $ = cheerio.load(html);
                const functions = [];
                // Look for function links in the module page
                $("a[href*='fn.']").each((_, el) => {
                    const href = $(el).attr("href");
                    const text = $(el).text().trim();
                    if (href && text && href.includes("fn.")) {
                        const match = href.match(/fn\.([^.]+)\.html/);
                        if (match && match[1]) {
                            const functionName = match[1];
                            let functionUrl;
                            if (href.startsWith("http")) {
                                functionUrl = href;
                            }
                            else if (href.startsWith("/")) {
                                functionUrl = `https://docs.rs${href}`;
                            }
                            else {
                                functionUrl = `${config.baseUrls.hdk}/${module}/${href}`;
                            }
                            functions.push({
                                name: functionName,
                                url: functionUrl,
                            });
                        }
                    }
                });
                console.error(`Discovered ${functions.length} functions in ${module} module`);
                return functions;
            },
            catch: (error) => new ParseError({
                message: `Failed to parse ${module} module: ${error}`,
            }),
        })), Effect.catchAll(() => Effect.succeed([])))), Effect.all, Effect.map(Array.flatten), Effect.map((functions) => {
            // Remove duplicates and cache
            const uniqueFunctionMap = new Map();
            functions.forEach(f => uniqueFunctionMap.set(f.name, f));
            const uniqueFunctions = [...uniqueFunctionMap.values()];
            hdkFunctionCache.set("hdk_functions", {
                functions: uniqueFunctions,
                timestamp: Date.now(),
            });
            console.error(`Fallback discovery found ${uniqueFunctions.length} unique HDK functions`);
            return uniqueFunctions;
        }));
    };
    const getHDKFunctionDocs = (functionName) => {
        return pipe(discoverHDKFunctions(), Effect.flatMap((hdkFunctions) => {
            // Use fuzzy search to find the best matching function
            const fuse = new Fuse(hdkFunctions, {
                keys: ["name"],
                includeScore: true,
                threshold: 0.3, // Allow some fuzzy matching
            });
            const searchResults = fuse.search(functionName);
            return pipe(Option.fromNullable(searchResults[0]), Option.match({
                onNone: () => Effect.fail(new NotFoundError({
                    message: `HDK function not found: ${functionName}. Available functions: ${hdkFunctions
                        .map((f) => f.name)
                        .slice(0, 20)
                        .join(", ")}${hdkFunctions.length > 20
                        ? `, and ${hdkFunctions.length - 20} more...`
                        : ""}`,
                })),
                onSome: (result) => {
                    console.error(`Found HDK function '${functionName}' -> '${result.item.name}' at: ${result.item.url} (score: ${result.score})`);
                    return fetchDocumentationPage(result.item.url);
                },
            }));
        }), Effect.catchAll((error) => {
            console.error(`Failed to lookup HDK function '${functionName}':`, {
                error: error._tag ? error : String(error),
                functionName,
            });
            return Effect.fail(new NotFoundError({
                message: `Failed to lookup HDK function: ${functionName}. Error: ${error._tag || String(error)}`,
            }));
        }));
    };
    const getConceptDocs = (concept) => {
        const conceptMappings = {
            "source chain": "/concepts/3_source_chain",
            dht: "/concepts/4_dht",
            links: "/concepts/5_links_anchors",
            anchors: "/concepts/5_links_anchors",
            zome: "/concepts/6_zome_functions",
            validation: "/concepts/7_validation",
            architecture: "/concepts/2_application_architecture",
            basics: "/concepts/1_the_basics",
        };
        const normalizedConcept = concept.toLowerCase();
        return pipe(Object.entries(conceptMappings), Array.findFirst(([key]) => normalizedConcept.includes(key) || key.includes(normalizedConcept)), Option.match({
            onNone: () => Effect.fail(new NotFoundError({ message: `Concept not found: ${concept}` })),
            onSome: ([, path]) => {
                const url = `${config.baseUrls.developer}${path}`;
                return fetchDocumentationPage(url);
            },
        }));
    };
    return {
        searchDeveloperDocs,
        searchRustDocs,
        fetchDocumentationPage,
        getHDKFunctionDocs,
        getConceptDocs,
    };
})).pipe(Layer.provide(HolochainConfigLive), Layer.provide(HttpServiceLive), Layer.provide(DocumentationParserLive));
// ==== MCP Server Setup ====
const server = new McpServer({
    name: "holochain-docs",
    version: "1.0.0",
});
// Create the runtime layer
const MainLive = HolochainDocServiceLive.pipe(Layer.provide(HttpServiceLive), Layer.provide(HolochainConfigLive));
let runPromise;
// Helper function to safely decode input
const safeDecodeInput = (schema) => (input) => pipe(Schema.decodeUnknown(schema)(input), Effect.mapError((error) => ({ error: `Invalid input: ${error}` })));
// Tool: Search Holochain docs
server.registerTool("search_holochain_docs", {
    description: "Search across all Holochain documentation sources including developer guides, HDK, and HDI docs",
    inputSchema: {
        query: z.string().describe("Search query for Holochain documentation"),
        source: z
            .enum(["all", "developer", "hdk", "hdi"])
            .optional()
            .describe("Specific documentation source to search (default: all)"),
    },
}, async (input) => {
    const searchProgram = Effect.gen(function* () {
        const decodedInput = yield* safeDecodeInput(SearchInputSchema)(input);
        const docService = yield* HolochainDocServiceTag;
        const { query, source = "all" } = decodedInput;
        let allResults = [];
        if (source === "all" || source === "developer") {
            const devResults = yield* docService.searchDeveloperDocs(query);
            allResults = [...allResults, ...devResults];
        }
        if (source === "all" || source === "hdk") {
            const hdkResults = yield* docService.searchRustDocs(query, "hdk");
            allResults = [...allResults, ...hdkResults];
        }
        if (source === "all" || source === "hdi") {
            const hdiResults = yield* docService.searchRustDocs(query, "hdi");
            allResults = [...allResults, ...hdiResults];
        }
        return { results: allResults, query };
    });
    const result = await runPromise(searchProgram.pipe(Effect.catchAll((error) => {
        const errorMessage = typeof error === "object" && error !== null
            ? JSON.stringify(error, null, 2)
            : String(error);
        return pipe(Console.error(`Search error: ${errorMessage}`), Effect.as({
            results: [],
            query: "unknown",
            error: errorMessage,
        }));
    })));
    if ("error" in result) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error searching documentation: ${result.error}`,
                },
            ],
        };
    }
    const resultText = result.results
        .map((r) => `**${r.title}** (${r.source})\n${r.url}\n${r.snippet}\n`)
        .join("\n---\n\n");
    return {
        content: [
            {
                type: "text",
                text: result.results.length > 0
                    ? `Found ${result.results.length} results for "${result.query}":\n\n${resultText}`
                    : `No results found for "${result.query}"`,
            },
        ],
    };
});
// Tool: Fetch documentation page
server.registerTool("fetch_holochain_doc", {
    description: "Fetch the complete content of a specific Holochain documentation page",
    inputSchema: {
        url: z.string().describe("URL of the documentation page to fetch"),
    },
}, async (input) => {
    const fetchProgram = Effect.gen(function* () {
        const decodedInput = yield* safeDecodeInput(FetchInputSchema)(input);
        const docService = yield* HolochainDocServiceTag;
        const doc = yield* docService.fetchDocumentationPage(decodedInput.url);
        return doc;
    });
    const result = await runPromise(fetchProgram.pipe(Effect.catchAll((error) => Effect.succeed({
        error: typeof error === "object" && error !== null
            ? JSON.stringify(error, null, 2)
            : String(error),
    }))));
    if ("error" in result) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching documentation: ${result.error}`,
                },
            ],
        };
    }
    return {
        content: [
            {
                type: "text",
                text: `# ${result.title}\n\nSource: ${result.source}\nURL: ${result.url}\n\n${result.content}`,
            },
        ],
    };
});
// Tool: Get HDK function documentation
server.registerTool("get_hdk_function", {
    description: "Get documentation for a specific HDK function",
    inputSchema: {
        functionName: z
            .string()
            .describe("Name of the HDK function (e.g., create_entry, get_links, call)"),
    },
}, async (input) => {
    const functionProgram = Effect.gen(function* () {
        const decodedInput = yield* safeDecodeInput(FunctionInputSchema)(input);
        const docService = yield* HolochainDocServiceTag;
        const doc = yield* docService.getHDKFunctionDocs(decodedInput.functionName);
        return doc;
    });
    const result = await runPromise(functionProgram.pipe(Effect.catchAll((error) => Effect.succeed({
        error: typeof error === "object" && error !== null
            ? JSON.stringify(error, null, 2)
            : String(error),
    }))));
    if ("error" in result) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching HDK function documentation: ${result.error}`,
                },
            ],
        };
    }
    return {
        content: [
            {
                type: "text",
                text: `# HDK Function: ${result.title}\n\nURL: ${result.url}\n\n${result.content}`,
            },
        ],
    };
});
// Tool: Get concept documentation
server.registerTool("get_holochain_concept", {
    description: "Get documentation for Holochain concepts like source chain, DHT, links, etc.",
    inputSchema: {
        concept: z
            .string()
            .describe("Holochain concept to get documentation for (e.g., 'source chain', 'dht', 'links', 'validation')"),
    },
}, async (input) => {
    const conceptProgram = Effect.gen(function* () {
        const decodedInput = yield* safeDecodeInput(ConceptInputSchema)(input);
        const docService = yield* HolochainDocServiceTag;
        const doc = yield* docService.getConceptDocs(decodedInput.concept);
        return doc;
    });
    const result = await runPromise(conceptProgram.pipe(Effect.catchAll((error) => Effect.succeed({
        error: typeof error === "object" && error !== null
            ? JSON.stringify(error, null, 2)
            : String(error),
    }))));
    if ("error" in result) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching concept documentation: ${result.error}`,
                },
            ],
        };
    }
    return {
        content: [
            {
                type: "text",
                text: `# Holochain Concept: ${result.title}\n\nURL: ${result.url}\n\n${result.content}`,
            },
        ],
    };
});
// Tool: List HDK modules
server.registerTool("list_hdk_modules", {
    description: "List available HDK modules and their main functions",
    inputSchema: {},
}, async () => {
    const modules = {
        entry: ["create_entry", "get", "update_entry", "delete_entry"],
        link: ["create_link", "get_links", "delete_link", "get_link_details"],
        agent: ["agent_info"],
        chain: ["get_chain_head", "query"],
        capability: ["create_cap_grant", "create_cap_claim"],
        ed25519: ["sign", "verify_signature"],
        hash: ["hash"],
        info: ["dna_info", "zome_info", "call_info"],
        p2p: ["call", "call_remote", "emit_signal"],
        random: ["random_bytes"],
        time: ["sys_time", "schedule"],
        x_salsa20_poly1305: ["encrypt", "decrypt"],
    };
    const moduleList = Object.entries(modules)
        .map(([module, functions]) => `**${module}**: ${functions.join(", ")}`)
        .join("\n");
    return {
        content: [
            {
                type: "text",
                text: `# HDK Modules and Functions\n\n${moduleList}\n\nUse 'get_hdk_function' tool to get detailed documentation for any function.`,
            },
        ],
    };
});
// Testing exports will be added later
// Start the server
async function main() {
    const scope = await Effect.runPromise(Scope.make());
    const runtime = await Effect.runPromise(Layer.toRuntime(MainLive).pipe(Effect.provideService(Scope.Scope, scope)));
    runPromise = Runtime.runPromise(runtime);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Holochain MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
