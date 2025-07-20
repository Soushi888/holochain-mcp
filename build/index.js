#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import { Effect, Context, Layer, pipe, Array, Option, Match, Console, Schema, Order, } from "effect";
import { z } from "zod";
import { HttpClient, HttpClientRequest, HttpClientResponse, } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
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
const HttpServiceLive = Layer.effect(HttpServiceTag, Effect.gen(function* () {
    const config = yield* HolochainConfigService;
    const httpClient = yield* HttpClient.HttpClient;
    const fetchPage = (url) => pipe(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({
        "User-Agent": config.userAgent,
    })), httpClient.execute, Effect.flatMap((response) => response.text), Effect.mapError(() => new FetchError({ message: `Failed to fetch: ${url}` })), Effect.timeout(config.timeout), Effect.mapError(() => new FetchError({ message: `Timeout fetching: ${url}` })));
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
            // Extract snippet around first match
            const index = content.indexOf(firstTerm);
            const start = Math.max(0, index - 100);
            const end = Math.min(content.length, index + 200);
            const snippet = html
                .substring(start, end)
                .replace(/<[^>]*>/g, "")
                .trim();
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
            const result = pipe(url, Match.value, Match.when((url) => url.includes("developer.holochain.org"), () => ({
                title: $("h1").first().text() || $("title").text(),
                content: $("main").text() || $(".content").text() || $("article").text(),
                source: "developer.holochain.org",
            })), Match.when((url) => url.includes("docs.rs"), () => ({
                title: $(".fqn").text() || $("h1").first().text(),
                content: $(".docblock")
                    .map((_, el) => $(el).text())
                    .get()
                    .join("\n\n"),
                source: url.includes("/hdk/") ? "docs.rs/hdk" : "docs.rs/hdi",
            })), Match.orElse(() => ({
                title: $("title").text(),
                content: $("body").text(),
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
    const getHDKFunctionDocs = (functionName) => {
        const commonFunctions = [
            "create_entry",
            "get",
            "update_entry",
            "delete_entry",
            "create_link",
            "get_links",
            "delete_link",
            "agent_info",
            "dna_info",
            "zome_info",
            "call",
            "call_remote",
            "emit_signal",
            "create_cap_grant",
            "create_cap_claim",
            "hash",
            "verify_signature",
            "sign",
        ];
        return pipe(commonFunctions, Array.findFirst((fn) => fn.toLowerCase().includes(functionName.toLowerCase()) ||
            functionName.toLowerCase().includes(fn.toLowerCase())), Option.match({
            onNone: () => Effect.fail(new NotFoundError({
                message: `HDK function not found: ${functionName}`,
            })),
            onSome: (matchedFunction) => {
                const url = `${config.baseUrls.hdk}/fn.${matchedFunction}.html`;
                return fetchDocumentationPage(url);
            },
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
    const result = await Effect.runPromise(searchProgram.pipe(Effect.provide(MainLive), Effect.catchAll((error) => {
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
    const result = await Effect.runPromise(fetchProgram.pipe(Effect.provide(MainLive), Effect.catchAll((error) => Effect.succeed({
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
    const result = await Effect.runPromise(functionProgram.pipe(Effect.provide(MainLive), Effect.catchAll((error) => Effect.succeed({
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
    const result = await Effect.runPromise(conceptProgram.pipe(Effect.provide(MainLive), Effect.catchAll((error) => Effect.succeed({
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
// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Holochain MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
