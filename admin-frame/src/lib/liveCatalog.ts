import type { MockCollection, MockProduct, MockProductVariant, ResourcePickerOptions } from "./mockCatalog";

/**
 * Live shop mode (mock-bridge started with MOCK_BRIDGE_ADMIN_ACCESS_TOKEN):
 * the resource picker lists the real store's products / collections. The
 * query goes through /mock-admin-api, which forwards it to the store
 * server-side (the token never reaches the browser). Results are mapped to the
 * mock catalog shapes so the selection payload sent to the app is unchanged.
 */

const API_VERSION = '2025-07';

const PRODUCT_FIELDS = `
  id title handle vendor productType status createdAt updatedAt descriptionHtml
  hasOnlyDefaultVariant publishedAt tags templateSuffix totalInventory tracksInventory
  options { id name position values }
  images(first: 5) { nodes { id url altText } }
  variants(first: 50) {
    nodes {
      id title price compareAtPrice availableForSale displayName barcode sku taxable
      inventoryPolicy inventoryQuantity position
      selectedOptions { value }
      inventoryItem { id }
    }
  }
`;

const COLLECTION_FIELDS = `
  id title handle description descriptionHtml sortOrder templateSuffix updatedAt
  image { id url altText }
  productsCount { count }
`;

async function adminGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch('/mock-admin-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `/admin/api/${API_VERSION}/graphql.json`,
      method: 'POST',
      body: { query, variables },
    }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(`Live Admin API ${response.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }
  return json.data as T;
}

function toProduct(node: any): MockProduct {
  const variants: MockProductVariant[] = (node.variants?.nodes ?? []).map((variant: any) => ({
    id: variant.id,
    title: variant.title,
    price: String(variant.price ?? '0.00'),
    compareAtPrice: variant.compareAtPrice ?? null,
    availableForSale: Boolean(variant.availableForSale),
    displayName: variant.displayName ?? `${node.title} - ${variant.title}`,
    barcode: variant.barcode ?? null,
    selectedOptions: variant.selectedOptions ?? [],
    fulfillmentService: { id: 'gid://shopify/FulfillmentService/manual', inventoryManagement: true, productBased: true, serviceName: 'Manual', type: 'MANUAL' },
    inventoryItem: { id: variant.inventoryItem?.id ?? '' },
    inventoryManagement: 'SHOPIFY',
    inventoryPolicy: variant.inventoryPolicy ?? 'DENY',
    inventoryQuantity: variant.inventoryQuantity ?? 0,
    position: variant.position ?? 1,
    requiresShipping: true,
    sku: variant.sku ?? null,
    taxable: Boolean(variant.taxable),
    weight: null,
    weightUnit: 'KILOGRAMS',
  } as MockProductVariant));

  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    vendor: node.vendor ?? '',
    productType: node.productType ?? '',
    status: node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    availablePublicationCount: 1,
    descriptionHtml: node.descriptionHtml ?? '',
    hasOnlyDefaultVariant: Boolean(node.hasOnlyDefaultVariant),
    options: node.options ?? [],
    publishedAt: node.publishedAt ?? null,
    tags: node.tags ?? [],
    templateSuffix: node.templateSuffix ?? null,
    totalInventory: node.totalInventory ?? 0,
    totalVariants: variants.length,
    tracksInventory: Boolean(node.tracksInventory),
    images: (node.images?.nodes ?? []).map((image: any) => ({
      id: image.id,
      originalSrc: image.url,
      altText: image.altText ?? '',
    })),
    variants,
    hidden: node.publishedAt == null,
  };
}

function toCollection(node: any): MockCollection {
  const count = node.productsCount?.count ?? 0;
  return {
    id: node.id,
    title: node.title,
    handle: node.handle,
    description: node.description ?? '',
    descriptionHtml: node.descriptionHtml ?? '',
    image: node.image ? { id: node.image.id, originalSrc: node.image.url, altText: node.image.altText ?? '' } : null,
    productsCount: count,
    productsAutomaticallySortedCount: count,
    productsManuallySortedCount: 0,
    availablePublicationCount: 1,
    publicationCount: 1,
    ruleSet: null,
    seo: {},
    sortOrder: 'MANUAL',
    storefrontId: node.id.replace('/Collection/', '/CollectionStorefront/'),
    templateSuffix: node.templateSuffix ?? null,
    updatedAt: node.updatedAt,
  } as MockCollection;
}

/** Shopify search syntax for the picker's text box and status filters. */
function productQuery(options: ResourcePickerOptions, search: string) {
  const parts: string[] = [];
  if (search.trim()) parts.push(search.trim());
  if (options.filter?.query) parts.push(options.filter.query);
  if (options.filter?.draft === false) parts.push('-status:draft');
  if (options.filter?.archived === false) parts.push('-status:archived');
  return parts.join(' ') || null;
}

export type LivePickerResult = {
  products: MockProduct[];
  collections: MockCollection[];
};

export async function fetchLiveResources(options: ResourcePickerOptions, search: string): Promise<LivePickerResult> {
  if (options.type === 'collection') {
    const data = await adminGraphql<{ collections: { nodes: any[] } }>(
      `query MockBridgePickerCollections($query: String) { collections(first: 50, query: $query, sortKey: TITLE) { nodes { ${COLLECTION_FIELDS} } } }`,
      { query: search.trim() || null },
    );
    return { products: [], collections: data.collections.nodes.map(toCollection) };
  }

  const data = await adminGraphql<{ products: { nodes: any[] } }>(
    `query MockBridgePickerProducts($query: String) { products(first: 50, query: $query, sortKey: TITLE) { nodes { ${PRODUCT_FIELDS} } } }`,
    { query: productQuery(options, search) },
  );
  return { products: data.products.nodes.map(toProduct), collections: [] };
}

/** Same item shapes as listPickerResources / resolveSelection in mockCatalog. */
export function liveItems(options: ResourcePickerOptions, result: LivePickerResult) {
  if (options.type === 'collection') return result.collections;
  if (options.type === 'variant') {
    return result.products
      .filter(product => product.status === 'ACTIVE')
      .flatMap(product => product.variants.map(variant => ({
        ...variant,
        product: { id: product.id, title: product.title, handle: product.handle },
        image: product.images[0] ?? null,
      })));
  }
  return result.products;
}
