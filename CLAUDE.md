# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Build**: `npm run build` - Compiles TypeScript to JavaScript in `build/` directory and makes the output executable
- **Development**: `npm run dev` - Runs TypeScript compiler in watch mode for continuous compilation
- **Start**: `npm start` - Runs the compiled MCP server
- **Testing**: `npm run inspector` - Launches MCP Inspector at http://localhost:4000 for interactive tool testing

## Project Architecture

This is a **Model Context Protocol (MCP) server** that provides AI agents with access to Holochain documentation. It's built using **Effect TS**, a functional programming library that provides type-safe error handling, dependency injection, and concurrent operations.

### Core Architecture Components

1. **Effect TS Foundation**: The entire codebase is built around Effect's functional programming patterns:
   - Type-safe error handling with custom error classes (`FetchError`, `ParseError`, `NotFoundError`)
   - Dependency injection using Context and Layer patterns
   - Resource management with automatic cleanup
   - Concurrent operations for improved performance

2. **Service Architecture**:
   - `HolochainConfigService`: Configuration management for base URLs and timeouts
   - `HttpService`: HTTP client with dual fetching strategy (regular HTTP + Puppeteer for dynamic content)
   - `DocumentationParser`: HTML parsing for extracting documentation content
   - `HolochainDocumentationService`: Main service orchestrating documentation search and retrieval

3. **Dual Fetching Strategy**:
   - **Puppeteer**: Used for developer.holochain.org (handles dynamic content)
   - **Standard HTTP**: Used for docs.rs (static Rust documentation)

### Key Technical Details

- **TypeScript Configuration**: Uses latest ES modules with strict type checking
- **Schema Validation**: Uses Effect Schema for all input/output validation
- **Error Handling**: All operations return typed Effect programs with explicit error types
- **Resource Management**: Puppeteer browser instances are properly managed with Effect's resource system

### Documentation Sources

The server integrates with three main documentation sources:
- **developer.holochain.org**: Main developer guides and concepts
- **docs.rs/hdk**: HDK (Holochain Development Kit) Rust documentation
- **docs.rs/hdi**: HDI (Holochain Deterministic Integrity) Rust documentation

### MCP Tools Available

1. `search_holochain_docs` - Search across all documentation sources
2. `fetch_holochain_doc` - Get complete content of specific pages
3. `get_hdk_function` - Look up specific HDK functions
4. `get_holochain_concept` - Get explanations of Holochain concepts
5. `list_hdk_modules` - Browse available HDK modules

### Development Notes

- The main entry point is `index.ts` which contains all service implementations
- All schemas are defined at the top of the file using Effect Schema
- Services use dependency injection pattern with proper layering
- HTML parsing is handled by cheerio for server-side DOM manipulation
- Fuse.js is used for fuzzy search functionality across documentation content