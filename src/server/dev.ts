import { MockShopifyAdminServer } from ".";
import { MockShopifyAdminConfig } from "../types";

// Only SHOPIFY_APP_URL is required. Everything else falls back to the
// MockShopifyAdminServer defaults (see .env.example).
const APP_URL = process.env.SHOPIFY_APP_URL;
if (!APP_URL) throw new Error('SHOPIFY_APP_URL is not set (copy .env.example to .env)');

const env = (name: string) => process.env[name]?.trim() || undefined;

const config: MockShopifyAdminConfig = { appUrl: APP_URL };

const CLIENT_ID = env('SHOPIFY_CLIENT_ID');
if (CLIENT_ID) config.clientId = CLIENT_ID;

const CLIENT_SECRET = env('SHOPIFY_CLIENT_SECRET');
if (CLIENT_SECRET) config.clientSecret = CLIENT_SECRET;

const SHOP = env('SHOPIFY_SHOP');
if (SHOP) config.shop = SHOP;

const MOCK_USER_ID = env('MOCK_USER_ID');
if (MOCK_USER_ID) config.userId = MOCK_USER_ID;

const PORT = env('SHOPIFY_PORT');
if (PORT) {
  const port = Number(PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`SHOPIFY_PORT is invalid: ${PORT}`);
  config.port = port;
}

const DEBUG = env('SHOPIFY_DEBUG');
if (DEBUG) config.debug = DEBUG === 'true';

// Live shop mode: proxy Admin API calls to the real SHOPIFY_SHOP.
const ADMIN_ACCESS_TOKEN = env('MOCK_BRIDGE_ADMIN_ACCESS_TOKEN');
if (ADMIN_ACCESS_TOKEN) {
  if (!SHOP) throw new Error('MOCK_BRIDGE_ADMIN_ACCESS_TOKEN requires SHOPIFY_SHOP');
  config.adminApi = { accessToken: ADMIN_ACCESS_TOKEN };
}

const server = new MockShopifyAdminServer(config);

server.start();
