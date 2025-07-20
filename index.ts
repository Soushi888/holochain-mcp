#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as cheerio from "cheerio";
import {
  Effect,
  Context,
  Layer,
  pipe,
  Array,
  Option,
  Match,
  Console,
  Schema,
  Order,
  Runtime,
  Scope,
  Exit,
} from "effect";
import { z } from "zod";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
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

type SearchResult = Schema.Schema.Type<typeof SearchResultSchema>;
type DocumentationResult = Schema.Schema.Type<typeof DocumentationResultSchema>;
type SearchInput = Schema.Schema.Type<typeof SearchInputSchema>;
type FetchInput = Schema.Schema.Type<typeof FetchInputSchema>;
type FunctionInput = Schema.Schema.Type<typeof FunctionInputSchema>;
type ConceptInput = Schema.Schema.Type<typeof ConceptInputSchema>;
type HdkFunction = Schema.Schema.Type<typeof HdkFunctionSchema>;

// ==== Error Types ====
class FetchError extends Schema.TaggedError<FetchError>()("FetchError", {
  message: Schema.String,
}) {}

class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  message: Schema.String,
}) {}

class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFoundError",
  {
    message: Schema.String,
  }
) {}

// ==== Configuration ====
interface HolochainConfig {
  readonly baseUrls: {
    readonly developer: string;
    readonly hdk: string;
    readonly hdi: string;
  };
  readonly timeout: number;
  readonly userAgent: string;
}

const HolochainConfigService =
  Context.GenericTag<HolochainConfig>("HolochainConfig");

const HolochainConfigLive = Layer.succeed(HolochainConfigService, {
  baseUrls: {
    developer: "https://developer.holochain.org",
    hdk: "https://docs.rs/hdk/latest/hdk",
    hdi: "https://docs.rs/hdi/latest/hdi",
  },
  timeout: 10000,
  userAgent: "Holochain-MCP-Server/1.0.0",
});

// ==== HTTP Service ====
interface HttpService {
  readonly fetchPage: (url: string) => Effect.Effect<string, FetchError>;
}

const HttpServiceTag = Context.GenericTag<HttpService>("HttpService");

const HttpServiceLive = Layer.scoped(
  HttpServiceTag,
  Effect.gen(function* () {
    const config = yield* HolochainConfigService;
    const httpClient = yield* HttpClient.HttpClient;

    const browser = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => puppeteer.launch({ headless: true }),
        catch: (e) =>
          new FetchError({ message: `Puppeteer launch failed: ${e}` }),
      }),
      (browser) => Effect.promise(() => browser.close())
    );

    const fetchPage = (url: string): Effect.Effect<string, FetchError> => {
      if (url.includes("developer.holochain.org")) {
        return Effect.tryPromise({
          try: async () => {
            const page = await browser.newPage();
            try {
              await page.goto(url, {
                waitUntil: "networkidle2",
                timeout: config.timeout,
              });
              return await page.content();
            } finally {
              await page.close();
            }
          },
          catch: (error) =>
            new FetchError({
              message: `Puppeteer fetch failed for ${url}: ${error}`,
            }),
        }).pipe(
          Effect.timeout(config.timeout + 2000),
          Effect.mapError(
            () =>
              new FetchError({
                message: `Timeout fetching with puppeteer: ${url}`,
              })
          )
        );
      }

      return pipe(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({
            "User-Agent": config.userAgent,
          })
        ),
        httpClient.execute,
        Effect.flatMap((response) => response.text),
        Effect.mapError(
          () => new FetchError({ message: `Failed to fetch: ${url}` })
        ),
        Effect.timeout(config.timeout),
        Effect.mapError(
          () => new FetchError({ message: `Timeout fetching: ${url}` })
        )
      );
    };

    return { fetchPage };
  })
).pipe(Layer.provide(NodeHttpClient.layer));

// ==== Documentation Parser Service ====
interface DocumentationParser {
  readonly parseSearchResults: (
    html: string,
    url: string,
    searchTerms: string[]
  ) => Effect.Effect<Option.Option<SearchResult>, ParseError>;
  readonly parseDocumentationPage: (
    html: string,
    url: string
  ) => Effect.Effect<DocumentationResult, ParseError>;
  readonly parseHdkIndex: (
    html: string,
    baseUrl: string
  ) => Effect.Effect<HdkFunction[], ParseError>;
}

const DocumentationParserTag = Context.GenericTag<DocumentationParser>(
  "DocumentationParser"
);

const DocumentationParserLive = Layer.succeed(DocumentationParserTag, {
  parseSearchResults: (
    html: string,
    url: string,
    searchTerms: string[]
  ): Effect.Effect<Option.Option<SearchResult>, ParseError> =>
    Effect.try({
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
      catch: (error) =>
        new ParseError({ message: `Failed to parse search results: ${error}` }),
    }),

  parseDocumentationPage: (
    html: string,
    url: string
  ): Effect.Effect<DocumentationResult, ParseError> =>
    Effect.try({
      try: () => {
        const $ = cheerio.load(html);

        const result = pipe(
          url,
          Match.value,
          Match.when(
            (url) => url.includes("developer.holochain.org"),
            () => {
              // Simplified content extraction
              const content =
                $(".main-area").text().trim() ||
                $("body")
                  .text()
                  .trim()
                  .split("Get Started")[0]
                  ?.split("Developers")[0]
                  ?.trim() ||
                "Error: Could not extract main content.";

              return {
                title: $("h1").first().text() || $("title").text(),
                content,
                source: "developer.holochain.org",
              };
            }
          ),
          Match.when(
            (url) => url.includes("docs.rs"),
            () => ({
              title: $(".fqn").text() || $("h1").first().text(),
              content: $(".docblock")
                .map((_, el) => $(el).text())
                .get()
                .join("\n\n"),
              source: url.includes("/hdk/") ? "docs.rs/hdk" : "docs.rs/hdi",
            })
          ),
          Match.orElse(() => ({
            title: $("title").text(),
            content: $("body").text(),
            source: "unknown",
          }))
        );

        return {
          title: result.title.trim(),
          content: result.content.trim(),
          url,
          source: result.source,
        };
      },
      catch: (error) =>
        new ParseError({
          message: `Failed to parse documentation page: ${error}`,
        }),
    }),
  parseHdkIndex: (
    html: string,
    baseUrl: string
  ): Effect.Effect<HdkFunction[], ParseError> =>
    Effect.try({
      try: () => {
        const $ = cheerio.load(html);
        const functions: HdkFunction[] = [];

        // Look for all function links, including those in modules
        $("a[href*='fn.']").each((_, el) => {
          const href = $(el).attr("href");
          const text = $(el).text().trim();

          if (href && text) {
            // Extract function name from either the text or the href
            let functionName = text;

            // If the text looks like a module path (e.g., "crate::entry::create_entry"),
            // extract just the function name
            if (functionName.includes("::")) {
              functionName = functionName.split("::").pop() || functionName;
            }

            functions.push({
              name: functionName,
              url: `${baseUrl}/${href}`, // href already contains the full path like "entry/fn.create_entry.html"
            });
          }
        });

        console.log(
          `Found ${functions.length} HDK functions:`,
          functions.map((f) => f.name)
        );
        return functions;
      },
      catch: (error) =>
        new ParseError({ message: `Failed to parse HDK index: ${error}` }),
    }),
});

// ==== Holochain Documentation Service ====
interface HolochainDocService {
  readonly searchDeveloperDocs: (
    query: string
  ) => Effect.Effect<SearchResult[], FetchError | ParseError>;
  readonly searchRustDocs: (
    query: string,
    docType: "hdk" | "hdi"
  ) => Effect.Effect<SearchResult[], FetchError | ParseError>;
  readonly fetchDocumentationPage: (
    url: string
  ) => Effect.Effect<
    DocumentationResult,
    FetchError | ParseError | NotFoundError
  >;
  readonly getHDKFunctionDocs: (
    functionName: string
  ) => Effect.Effect<
    DocumentationResult,
    FetchError | ParseError | NotFoundError
  >;
  readonly getConceptDocs: (
    concept: string
  ) => Effect.Effect<
    DocumentationResult,
    FetchError | ParseError | NotFoundError
  >;
}

const HolochainDocServiceTag = Context.GenericTag<HolochainDocService>(
  "HolochainDocService"
);

const HolochainDocServiceLive = Layer.effect(
  HolochainDocServiceTag,
  Effect.gen(function* () {
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

    const searchDeveloperDocs = (
      query: string
    ): Effect.Effect<SearchResult[], FetchError | ParseError> =>
      pipe(
        commonDeveloperPages,
        Array.map((page) => `${config.baseUrls.developer}${page}`),
        Array.map((url) =>
          pipe(
            httpService.fetchPage(url),
            Effect.flatMap((html) =>
              parser.parseSearchResults(
                html,
                url,
                query.toLowerCase().split(" ")
              )
            ),
            Effect.map(Option.toArray),
            Effect.catchAll(() => Effect.succeed([]))
          )
        ),
        Effect.all,
        Effect.map(Array.flatten),
        Effect.map((results) =>
          pipe(
            results,
            Array.sortBy(
              Order.mapInput(
                Order.number,
                (r: SearchResult) => -r.snippet.length
              )
            ),
            Array.take(5)
          )
        )
      );

    const searchRustDocs = (
      query: string,
      docType: "hdk" | "hdi"
    ): Effect.Effect<SearchResult[], FetchError | ParseError> => {
      const paths = docType === "hdk" ? commonHDKPaths : commonHDIPaths;
      const baseUrl = config.baseUrls[docType];

      return pipe(
        paths,
        Array.map((path) => `${baseUrl}${path}`),
        Array.map((url) =>
          pipe(
            httpService.fetchPage(url),
            Effect.flatMap((html) =>
              parser.parseSearchResults(
                html,
                url,
                query.toLowerCase().split(" ")
              )
            ),
            Effect.map(Option.toArray),
            Effect.catchAll(() => Effect.succeed([]))
          )
        ),
        Effect.all,
        Effect.map(Array.flatten),
        Effect.map((results) =>
          pipe(
            results,
            Array.sortBy(
              Order.mapInput(
                Order.number,
                (r: SearchResult) => -r.snippet.length
              )
            ),
            Array.take(5)
          )
        )
      );
    };

    const fetchDocumentationPage = (
      url: string
    ): Effect.Effect<
      DocumentationResult,
      FetchError | ParseError | NotFoundError
    > =>
      pipe(
        httpService.fetchPage(url),
        Effect.flatMap((html) => parser.parseDocumentationPage(html, url)),
        Effect.mapError((error) =>
          error._tag === "FetchError"
            ? new NotFoundError({
                message: `Documentation page not found: ${url}`,
              })
            : error
        )
      );

    const getHDKFunctionDocs = (
      functionName: string
    ): Effect.Effect<
      DocumentationResult,
      FetchError | ParseError | NotFoundError
    > => {
      // Build the HDK function cache on-demand for each request
      const hdkIndexUrl = `${config.baseUrls.hdk}/index.html`;

      return pipe(
        httpService.fetchPage(hdkIndexUrl),
        Effect.flatMap((html) =>
          parser.parseHdkIndex(html, config.baseUrls.hdk)
        ),
        Effect.flatMap((hdkFunctionsCache) => {
          const fuse = new Fuse(hdkFunctionsCache, {
            keys: ["name"],
            includeScore: true,
            threshold: 0.4,
          });

          const searchResults = fuse.search(functionName);

          return pipe(
            Option.fromNullable(searchResults[0]),
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NotFoundError({
                    message: `HDK function not found: ${functionName}`,
                  })
                ),
              onSome: (result) => {
                return fetchDocumentationPage(result.item.url);
              },
            })
          );
        }),
        Effect.catchAll((error) => {
          console.error("Failed to lookup HDK function:", error);
          return Effect.fail(
            new NotFoundError({
              message: `Failed to lookup HDK function: ${functionName}`,
            })
          );
        })
      );
    };

    const getConceptDocs = (
      concept: string
    ): Effect.Effect<
      DocumentationResult,
      FetchError | ParseError | NotFoundError
    > => {
      const conceptMappings: Record<string, string> = {
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

      return pipe(
        Object.entries(conceptMappings),
        Array.findFirst(
          ([key]) =>
            normalizedConcept.includes(key) || key.includes(normalizedConcept)
        ),
        Option.match({
          onNone: () =>
            Effect.fail(
              new NotFoundError({ message: `Concept not found: ${concept}` })
            ),
          onSome: ([, path]) => {
            const url = `${config.baseUrls.developer}${path}`;
            return fetchDocumentationPage(url);
          },
        })
      );
    };

    return {
      searchDeveloperDocs,
      searchRustDocs,
      fetchDocumentationPage,
      getHDKFunctionDocs,
      getConceptDocs,
    };
  })
).pipe(
  Layer.provide(HolochainConfigLive),
  Layer.provide(HttpServiceLive),
  Layer.provide(DocumentationParserLive)
);

// ==== MCP Server Setup ====
const server = new McpServer({
  name: "holochain-docs",
  version: "1.0.0",
});

// Create the runtime layer
const MainLive = HolochainDocServiceLive.pipe(
  Layer.provide(HttpServiceLive),
  Layer.provide(HolochainConfigLive)
);

let runPromise: <E, A>(
  effect: Effect.Effect<A, E, HolochainDocService>
) => Promise<A>;

// Helper function to safely decode input
const safeDecodeInput =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (input: unknown) =>
    pipe(
      Schema.decodeUnknown(schema)(input),
      Effect.mapError((error) => ({ error: `Invalid input: ${error}` }))
    );

// Tool: Search Holochain docs
server.registerTool(
  "search_holochain_docs",
  {
    description:
      "Search across all Holochain documentation sources including developer guides, HDK, and HDI docs",
    inputSchema: {
      query: z.string().describe("Search query for Holochain documentation"),
      source: z
        .enum(["all", "developer", "hdk", "hdi"])
        .optional()
        .describe("Specific documentation source to search (default: all)"),
    },
  },
  async (input: unknown) => {
    const searchProgram = Effect.gen(function* () {
      const decodedInput = yield* safeDecodeInput(SearchInputSchema)(input);
      const docService = yield* HolochainDocServiceTag;
      const { query, source = "all" } = decodedInput;

      let allResults: SearchResult[] = [];

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

    const result = await runPromise(
      searchProgram.pipe(
        Effect.catchAll((error) => {
          const errorMessage =
            typeof error === "object" && error !== null
              ? JSON.stringify(error, null, 2)
              : String(error);
          return pipe(
            Console.error(`Search error: ${errorMessage}`),
            Effect.as({
              results: [],
              query: "unknown",
              error: errorMessage,
            })
          );
        })
      )
    );

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
      .map(
        (r: SearchResult) =>
          `**${r.title}** (${r.source})\n${r.url}\n${r.snippet}\n`
      )
      .join("\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text:
            result.results.length > 0
              ? `Found ${result.results.length} results for "${result.query}":\n\n${resultText}`
              : `No results found for "${result.query}"`,
        },
      ],
    };
  }
);

// Tool: Fetch documentation page
server.registerTool(
  "fetch_holochain_doc",
  {
    description:
      "Fetch the complete content of a specific Holochain documentation page",
    inputSchema: {
      url: z.string().describe("URL of the documentation page to fetch"),
    },
  },
  async (input: unknown) => {
    const fetchProgram = Effect.gen(function* () {
      const decodedInput = yield* safeDecodeInput(FetchInputSchema)(input);
      const docService = yield* HolochainDocServiceTag;
      const doc = yield* docService.fetchDocumentationPage(decodedInput.url);
      return doc;
    });

    const result = await runPromise(
      fetchProgram.pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            error:
              typeof error === "object" && error !== null
                ? JSON.stringify(error, null, 2)
                : String(error),
          })
        )
      )
    );

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
  }
);

// Tool: Get HDK function documentation
server.registerTool(
  "get_hdk_function",
  {
    description: "Get documentation for a specific HDK function",
    inputSchema: {
      functionName: z
        .string()
        .describe(
          "Name of the HDK function (e.g., create_entry, get_links, call)"
        ),
    },
  },
  async (input: unknown) => {
    const functionProgram = Effect.gen(function* () {
      const decodedInput = yield* safeDecodeInput(FunctionInputSchema)(input);
      const docService = yield* HolochainDocServiceTag;
      const doc = yield* docService.getHDKFunctionDocs(
        decodedInput.functionName
      );
      return doc;
    });

    const result = await runPromise(
      functionProgram.pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            error:
              typeof error === "object" && error !== null
                ? JSON.stringify(error, null, 2)
                : String(error),
          })
        )
      )
    );

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
  }
);

// Tool: Get concept documentation
server.registerTool(
  "get_holochain_concept",
  {
    description:
      "Get documentation for Holochain concepts like source chain, DHT, links, etc.",
    inputSchema: {
      concept: z
        .string()
        .describe(
          "Holochain concept to get documentation for (e.g., 'source chain', 'dht', 'links', 'validation')"
        ),
    },
  },
  async (input: unknown) => {
    const conceptProgram = Effect.gen(function* () {
      const decodedInput = yield* safeDecodeInput(ConceptInputSchema)(input);
      const docService = yield* HolochainDocServiceTag;
      const doc = yield* docService.getConceptDocs(decodedInput.concept);
      return doc;
    });

    const result = await runPromise(
      conceptProgram.pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            error:
              typeof error === "object" && error !== null
                ? JSON.stringify(error, null, 2)
                : String(error),
          })
        )
      )
    );

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
  }
);

// Tool: List HDK modules
server.registerTool(
  "list_hdk_modules",
  {
    description: "List available HDK modules and their main functions",
    inputSchema: {},
  },
  async () => {
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
  }
);

// Start the server
async function main() {
  const scope = await Effect.runPromise(Scope.make());
  const runtime = await Effect.runPromise(
    Layer.toRuntime(MainLive).pipe(Effect.provideService(Scope.Scope, scope))
  );
  runPromise = Runtime.runPromise(runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Holochain MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
