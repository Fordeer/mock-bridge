import { Express, Request, Response } from 'express';

/**
 * Mock Shopify app billing (recurring subscriptions).
 *
 * Real billing needs a merchant approval on Shopify's confirmation page, which
 * e2e cannot reach (mock session tokens, real or fake store). App backends route
 * their billing GraphQL here (POST /mock-billing/graphql) instead of Shopify:
 *
 *   appSubscriptionCreate → PENDING subscription + confirmationUrl (mock page)
 *   confirm page Approve  → ACTIVE (other ACTIVE ones CANCELLED, like Shopify's
 *                           STANDARD replacement) → 302 returnUrl?charge_id=<id>
 *   confirm page Decline  → DECLINED → 302 returnUrl?charge_id=<id>
 *   currentAppInstallation { activeSubscriptions } → ACTIVE subscriptions
 *   appSubscriptionCancel → CANCELLED
 *   appUsageRecordCreate  → usage charge on an ACTIVE subscription's usage line
 *                           item (adds to balanceUsed, capped at cappedAmount)
 *
 * State is in memory per shop: restarting mock-bridge resets every store to
 * "no active subscription" (FREE).
 */

type Money = { amount: string; currencyCode: string };

type PricingDetails =
  | { __typename: 'AppRecurringPricing'; interval: string; price: Money; discount?: unknown }
  | { __typename: 'AppUsagePricing'; interval: string; cappedAmount: Money; balanceUsed: Money; terms: string };

type MockSubscription = {
  numericId: string;
  shop: string;
  name: string;
  status: 'PENDING' | 'ACTIVE' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  test: boolean;
  trialDays: number;
  returnUrl: string;
  createdAt: string;
  currentPeriodEnd: string | null;
  lineItems: PricingDetails[];
};

type BillingOptions = {
  clientId: () => string | undefined;
  /** Browser-facing base URL of this mock admin, e.g. http://127.0.0.1:3082 */
  publicUrl: () => string;
  debug: () => boolean;
};

const subscriptions = new Map<string, MockSubscription>();
let lastId = Date.now();

/** Numeric ids unlike any earlier run: apps match DB rows with LIKE %charge_id%. */
function nextId() {
  lastId = Math.max(lastId + 1, Date.now());
  return String(lastId);
}

function gid(sub: MockSubscription) {
  return `gid://shopify/AppSubscription/${sub.numericId}`;
}

function money(input: any): Money {
  return {
    amount: String(input?.amount ?? '0.0'),
    currencyCode: String(input?.currencyCode ?? 'USD'),
  };
}

function lineItemsFrom(variables: any): PricingDetails[] {
  const items: any[] = Array.isArray(variables?.lineItems) ? variables.lineItems : [];
  return items.flatMap((item): PricingDetails[] => {
    const plan = item?.plan ?? {};
    if (plan.appRecurringPricingDetails) {
      const details = plan.appRecurringPricingDetails;
      return [{
        __typename: 'AppRecurringPricing',
        interval: details.interval ?? 'EVERY_30_DAYS',
        price: money(details.price),
        ...(details.discount ? { discount: details.discount } : {}),
      }];
    }
    if (plan.appUsagePricingDetails) {
      const details = plan.appUsagePricingDetails;
      return [{
        __typename: 'AppUsagePricing',
        interval: 'EVERY_30_DAYS',
        cappedAmount: money(details.cappedAmount),
        balanceUsed: { amount: '0.0', currencyCode: money(details.cappedAmount).currencyCode },
        terms: String(details.terms ?? ''),
      }];
    }
    return [];
  });
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Trial, then one billing interval — the period Shopify reports after approval. */
function periodEnd(sub: MockSubscription, from: Date) {
  const afterTrial = addDays(from, sub.trialDays);
  const recurring = sub.lineItems.find(item => item.__typename === 'AppRecurringPricing');
  if (recurring?.interval === 'ANNUAL') {
    const end = new Date(afterTrial);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    return end.toISOString();
  }
  return addDays(afterTrial, 30).toISOString();
}

function toGraphql(sub: MockSubscription) {
  return {
    id: gid(sub),
    name: sub.name,
    status: sub.status,
    test: sub.test,
    trialDays: sub.trialDays,
    returnUrl: sub.returnUrl,
    createdAt: sub.createdAt,
    currentPeriodEnd: sub.currentPeriodEnd,
    lineItems: sub.lineItems.map((pricingDetails, index) => ({
      id: `gid://shopify/AppSubscriptionLineItem/${sub.numericId}?v=1&index=${index}`,
      plan: { pricingDetails },
    })),
  };
}

function numericIdFrom(id: unknown) {
  return String(id ?? '').replace(/\D/g, '');
}

function confirmationUrl(sub: MockSubscription, options: BillingOptions) {
  const clientId = encodeURIComponent(options.clientId() || 'app');
  return `${options.publicUrl()}/admin/charges/${clientId}/${sub.numericId}/confirm`;
}

function withChargeId(returnUrl: string, numericId: string) {
  const url = new URL(returnUrl);
  url.searchParams.set('charge_id', numericId);
  return url.toString();
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ));
}

function describe(item: PricingDetails) {
  if (item.__typename === 'AppRecurringPricing') {
    const per = item.interval === 'ANNUAL' ? 'year' : '30 days';
    const discount = item.discount ? ` (discount: ${escapeHtml(JSON.stringify(item.discount))})` : '';
    return `${escapeHtml(item.price.amount)} ${escapeHtml(item.price.currencyCode)} / ${per}${discount}`;
  }
  return `Usage, capped at ${escapeHtml(item.cappedAmount.amount)} ${escapeHtml(item.cappedAmount.currencyCode)} / 30 days`;
}

function confirmPage(sub: MockSubscription, clientId: string) {
  const base = `/admin/charges/${encodeURIComponent(clientId)}/${sub.numericId}`;
  const pending = sub.status === 'PENDING';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Approve subscription · Mock Shopify</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f1f1f1;margin:0;padding:48px 16px;color:#303030}
  .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.15);padding:24px}
  h1{font-size:20px;margin:0 0 4px} .muted{color:#616161;font-size:13px}
  dl{display:grid;grid-template-columns:140px 1fr;gap:8px;margin:20px 0} dt{color:#616161} dd{margin:0}
  .badge{display:inline-block;background:#ffd6a4;border-radius:8px;padding:2px 8px;font-size:12px}
  form{display:inline} button{border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}
  .approve{background:#303030;color:#fff} .decline{background:#fff;border:1px solid #c9c9c9;margin-right:8px}
  .actions{text-align:right;margin-top:16px}
</style></head>
<body><div class="card">
  <span class="badge">Mock Shopify billing — no real charge</span>
  <h1>Approve subscription</h1>
  <div class="muted">${escapeHtml(sub.shop)}</div>
  <dl>
    <dt>Plan</dt><dd data-testid="mock-billing-plan">${escapeHtml(sub.name)}</dd>
    <dt>Price</dt><dd>${sub.lineItems.map(describe).join('<br>') || '—'}</dd>
    <dt>Free trial</dt><dd>${sub.trialDays} days</dd>
    <dt>Test charge</dt><dd>${sub.test ? 'Yes' : 'No'}</dd>
    <dt>Status</dt><dd data-testid="mock-billing-status">${sub.status}</dd>
  </dl>
  ${pending ? `<div class="actions">
    <form method="post" action="${base}/decline"><button class="decline" type="submit">Decline</button></form>
    <form method="post" action="${base}/approve"><button class="approve" type="submit">Approve</button></form>
  </div>` : `<p class="muted">This charge is already ${sub.status.toLowerCase()}.</p>`}
</div></body></html>`;
}

function handleBillingGraphql(shop: string, query: string, variables: any, options: BillingOptions) {
  if (/\bappSubscriptionCreate\b/.test(query)) {
    const sub: MockSubscription = {
      numericId: nextId(),
      shop,
      name: String(variables?.name ?? 'Subscription'),
      status: 'PENDING',
      test: Boolean(variables?.test),
      trialDays: Number(variables?.trialDays ?? 0) || 0,
      returnUrl: String(variables?.returnUrl ?? ''),
      createdAt: new Date().toISOString(),
      currentPeriodEnd: null,
      lineItems: lineItemsFrom(variables),
    };
    try {
      new URL(sub.returnUrl);
    } catch {
      return {
        data: {
          appSubscriptionCreate: {
            userErrors: [{ field: ['returnUrl'], message: 'Return url is invalid' }],
            appSubscription: null,
            confirmationUrl: null,
          },
        },
      };
    }
    subscriptions.set(sub.numericId, sub);
    return {
      data: {
        appSubscriptionCreate: {
          userErrors: [],
          appSubscription: toGraphql(sub),
          confirmationUrl: confirmationUrl(sub, options),
        },
      },
    };
  }

  if (/\bappSubscriptionCancel\b/.test(query)) {
    const sub = subscriptions.get(numericIdFrom(variables?.id));
    if (!sub || sub.shop !== shop) {
      return {
        data: {
          appSubscriptionCancel: {
            userErrors: [{ field: ['id'], message: 'Subscription not found' }],
            appSubscription: null,
          },
        },
      };
    }
    sub.status = 'CANCELLED';
    return { data: { appSubscriptionCancel: { userErrors: [], appSubscription: toGraphql(sub) } } };
  }

  if (/\bappUsageRecordCreate\b/.test(query)) {
    const usageError = (field: string, message: string) => ({
      data: { appUsageRecordCreate: { userErrors: [{ field: [field], message }], appUsageRecord: null } },
    });
    // Line item ids come from toGraphql: gid://shopify/AppSubscriptionLineItem/<sub>?v=1&index=<n>
    const lineItemId = String(variables?.subscriptionLineItemId ?? '');
    const match = lineItemId.match(/AppSubscriptionLineItem\/(\d+)\?.*\bindex=(\d+)/);
    const sub = match ? subscriptions.get(match[1]) : undefined;
    if (!sub || sub.shop !== shop) return usageError('subscriptionLineItemId', 'Subscription line item not found');
    if (sub.status !== 'ACTIVE') return usageError('subscriptionLineItemId', 'Subscription is not active');
    const item = sub.lineItems[Number(match![2])];
    if (!item || item.__typename !== 'AppUsagePricing') {
      return usageError('subscriptionLineItemId', 'Line item does not have usage pricing');
    }
    const price = money(variables?.price);
    const nextBalance = Number(item.balanceUsed.amount) + Number(price.amount);
    if (nextBalance > Number(item.cappedAmount.amount)) {
      return usageError('price', 'Total price exceeds balance remaining');
    }
    item.balanceUsed = { amount: nextBalance.toFixed(2), currencyCode: item.balanceUsed.currencyCode };
    return {
      data: {
        appUsageRecordCreate: {
          userErrors: [],
          appUsageRecord: {
            id: `gid://shopify/AppUsageRecord/${nextId()}`,
            createdAt: new Date().toISOString(),
            description: String(variables?.description ?? ''),
            price,
            subscriptionLineItem: { id: lineItemId },
          },
        },
      },
    };
  }

  if (/\bactiveSubscriptions\b/.test(query)) {
    const active = [...subscriptions.values()].filter(sub => sub.shop === shop && sub.status === 'ACTIVE');
    return {
      data: {
        currentAppInstallation: {
          id: 'gid://shopify/AppInstallation/1',
          activeSubscriptions: active.map(toGraphql),
        },
      },
    };
  }

  return { errors: [{ message: 'mock-bridge billing: unsupported operation (supports appSubscriptionCreate, appSubscriptionCancel, appUsageRecordCreate, currentAppInstallation.activeSubscriptions)' }] };
}

export function registerMockBilling(app: Express, options: BillingOptions) {
  // Server-to-server from app backends (E2E_MOCK_BILLING).
  app.post('/mock-billing/graphql', (req: Request, res: Response) => {
    const shop = String(req.body?.shop ?? '').toLowerCase();
    const query = String(req.body?.query ?? '');
    if (!shop.endsWith('.myshopify.com')) {
      res.status(400).json({ errors: [{ message: 'shop (*.myshopify.com) is required' }] });
      return;
    }
    const result = handleBillingGraphql(shop, query, req.body?.variables ?? {}, options);
    if (options.debug()) {
      const op = Object.keys((result as any).data ?? {})[0] ?? 'error';
      console.log(`[MockBilling] ${shop} ${op}`);
    }
    res.json(result);
  });

  // Debug / test helper: current state of a shop.
  app.get('/mock-billing/subscriptions', (req: Request, res: Response) => {
    const shop = String(req.query.shop ?? '').toLowerCase();
    res.json([...subscriptions.values()].filter(sub => !shop || sub.shop === shop).map(toGraphql));
  });

  // Merchant approval page (confirmationUrl).
  app.get('/admin/charges/:clientId/:id/confirm', (req: Request, res: Response) => {
    const sub = subscriptions.get(req.params.id);
    if (!sub) {
      res.status(404).type('text/plain').send('Mock charge not found (mock-bridge restarted?)');
      return;
    }
    res.type('html').send(confirmPage(sub, req.params.clientId));
  });

  const decide = (approve: boolean) => (req: Request, res: Response) => {
    const sub = subscriptions.get(req.params.id);
    if (!sub) {
      res.status(404).type('text/plain').send('Mock charge not found (mock-bridge restarted?)');
      return;
    }
    if (sub.status === 'PENDING') {
      if (approve) {
        for (const other of subscriptions.values()) {
          if (other.shop === sub.shop && other.status === 'ACTIVE') other.status = 'CANCELLED';
        }
        sub.status = 'ACTIVE';
        sub.currentPeriodEnd = periodEnd(sub, new Date());
      } else {
        sub.status = 'DECLINED';
      }
      if (options.debug()) console.log(`[MockBilling] ${sub.shop} ${sub.name} → ${sub.status}`);
    }
    // Shopify returns to returnUrl with charge_id after approve or decline.
    res.redirect(303, withChargeId(sub.returnUrl, sub.numericId));
  };

  app.post('/admin/charges/:clientId/:id/approve', decide(true));
  app.post('/admin/charges/:clientId/:id/decline', decide(false));
}
