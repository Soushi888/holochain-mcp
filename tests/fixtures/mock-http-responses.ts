import { readFileSync } from "fs"
import { join } from "path"

export const MockResponses = {
  VALIDATION_PAGE: readFileSync(join(__dirname, "holochain-validation-page.html"), "utf-8"),
  HDK_CREATE_ENTRY_PAGE: readFileSync(join(__dirname, "hdk-create-entry-page.html"), "utf-8"),
  
  HDK_INDEX_PAGE: `
    <html>
      <head><title>HDK - Rust</title></head>
      <body>
        <h1>HDK Documentation</h1>
        <div class="item-list">
          <a href="entry/fn.create_entry.html">create_entry</a>
          <a href="entry/fn.get.html">get</a>
          <a href="entry/fn.update_entry.html">update_entry</a>
          <a href="link/fn.create_link.html">create_link</a>
          <a href="link/fn.get_links.html">get_links</a>
          <a href="agent/fn.agent_info.html">agent_info</a>
        </div>
      </body>
    </html>
  `,
  
  EMPTY_PAGE: `
    <html>
      <head><title>Not Found</title></head>
      <body><h1>404 - Page Not Found</h1></body>
    </html>
  `,
  
  DHT_CONCEPT_PAGE: `
    <html>
      <head><title>The DHT: A Shared, Distributed Graph Database</title></head>
      <body>
        <div class="main-area">
          <h1>The DHT: A Shared, Distributed Graph Database</h1>
          <p>The DHT (Distributed Hash Table) is a key component of Holochain's architecture.</p>
          <p>Unlike blockchain, Holochain uses a DHT for distributed storage and validation.</p>
          <p>Each agent maintains their own source chain while participating in the DHT.</p>
          <p>The DHT enables peer-to-peer data sharing without global consensus.</p>
        </div>
      </body>
    </html>
  `
}

export const getMockUrlContent = (url: string): string => {
  if (url.includes("/concepts/7_validation")) {
    return MockResponses.VALIDATION_PAGE
  }
  if (url.includes("/concepts/4_dht")) {
    return MockResponses.DHT_CONCEPT_PAGE
  }
  if (url.includes("hdk/latest/hdk/entry/fn.create_entry.html")) {
    return MockResponses.HDK_CREATE_ENTRY_PAGE
  }
  if (url.includes("hdk/latest/hdk/index.html")) {
    return MockResponses.HDK_INDEX_PAGE
  }
  
  return MockResponses.EMPTY_PAGE
}