import { useEffect, useMemo, useRef, useState } from "react";
import {
  listPickerResources,
  resolveSelection,
  type MockCollection,
  type MockProduct,
  type ResourcePickerOptions,
} from "../../lib/mockCatalog";
import { postToEmbeddedApp } from "../../lib/embeddedFrame";
import { useResourcePickerStore } from "../../store/features/resource-picker";
import { useConfig } from "../../hooks/useConfig";
import { fetchLiveResources, liveItems, type LivePickerResult } from "../../lib/liveCatalog";

function resourceThumb(item: MockProduct | MockCollection | { image?: { originalSrc: string } | null; displayName?: string; title?: string }) {
  if ('images' in item && item.images?.[0]?.originalSrc) return item.images[0].originalSrc;
  if ('image' in item && item.image && 'originalSrc' in item.image) return item.image.originalSrc;
  return '';
}

function resourceTitle(item: { title?: string; displayName?: string }) {
  return item.title || item.displayName || 'Untitled';
}

function resourceMeta(item: MockProduct | MockCollection | Record<string, unknown>, type: ResourcePickerOptions['type']) {
  if (type === 'collection') {
    const collection = item as MockCollection;
    return `${collection.productsCount} products`;
  }
  if (type === 'variant') {
    const variant = item as { price?: string; sku?: string | null };
    return [variant.sku, variant.price ? `$${variant.price}` : null].filter(Boolean).join(' · ');
  }
  const product = item as MockProduct;
  return [product.vendor, product.variants[0]?.price ? `$${product.variants[0].price}` : null].filter(Boolean).join(' · ');
}

function actionLabel(options: ResourcePickerOptions | null) {
  const verb = options?.action === 'select' ? 'Select' : 'Add';
  if (options?.type === 'collection') return `${verb}`;
  if (options?.type === 'variant') return `${verb}`;
  return verb;
}

function heading(options: ResourcePickerOptions | null) {
  const verb = options?.action === 'select' ? 'Select' : 'Add';
  if (options?.type === 'collection') return `${verb} collections`;
  if (options?.type === 'variant') return `${verb} variants`;
  return `${verb} products`;
}

/**
 * Mock Shopify Resource Picker. Lives in the admin frame so the embedded app
 * can await shopify.resourcePicker() like production App Bridge.
 * @see https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/resource-picker-api
 */
export function ResourcePicker() {
  const open = useResourcePickerStore(state => state.open);
  const requestId = useResourcePickerStore(state => state.requestId);
  const options = useResourcePickerStore(state => state.options);
  const selectedIds = useResourcePickerStore(state => state.selectedIds);
  const search = useResourcePickerStore(state => state.search);
  const openPicker = useResourcePickerStore(state => state.openPicker);
  const setSearch = useResourcePickerStore(state => state.setSearch);
  const toggleId = useResourcePickerStore(state => state.toggleId);
  const close = useResourcePickerStore(state => state.close);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'RESOURCE_PICKER_OPEN') return;
      if (typeof event.data.requestId !== 'string') return;
      if (!event.data.options?.type) return;
      openPicker({
        requestId: event.data.requestId,
        options: event.data.options as ResourcePickerOptions,
      });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [openPicker]);

  const config = useConfig();
  const live = Boolean(config?.liveAdminApi);
  const [liveResult, setLiveResult] = useState<LivePickerResult>({ products: [], collections: [] });
  const [liveState, setLiveState] = useState<'idle' | 'loading' | 'error'>('idle');
  // Every live item seen while the picker is open: selections can span searches.
  const seenLive = useRef(new Map<string, unknown>());

  useEffect(() => {
    if (!open) seenLive.current.clear();
  }, [open]);

  useEffect(() => {
    if (!live || !open || !options) return;
    let cancelled = false;
    setLiveState('loading');
    const timer = window.setTimeout(() => {
      fetchLiveResources(options, search)
        .then(result => {
          if (cancelled) return;
          for (const item of liveItems(options, result)) seenLive.current.set(String((item as { id: string }).id), item);
          setLiveResult(result);
          setLiveState('idle');
        })
        .catch(error => {
          if (cancelled) return;
          console.warn('[MockAdmin] live resource picker failed', error);
          setLiveState('error');
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [live, open, options, search]);

  const items = useMemo(() => {
    if (!options) return [];
    if (live) return liveItems(options, liveResult);
    return listPickerResources({
      ...options,
      query: search,
    });
  }, [options, search, live, liveResult]);

  if (!open || !options) return null;

  const finish = (selection: unknown[] | undefined) => {
    postToEmbeddedApp({
      type: 'RESOURCE_PICKER_RESULT',
      requestId,
      selection,
    });
    close();
  };

  const confirm = () => {
    finish(live
      ? selectedIds.map(id => seenLive.current.get(id)).filter(Boolean)
      : resolveSelection(options, selectedIds));
  };

  const cancel = () => finish(undefined);

  const multiple = options.multiple === true || typeof options.multiple === 'number';
  const confirmDisabled = selectedIds.length === 0;

  return (
    <div className="resource-picker-backdrop" role="presentation" onClick={cancel}>
      <div
        className="resource-picker"
        role="dialog"
        aria-modal="true"
        aria-label={heading(options)}
        onClick={event => event.stopPropagation()}
      >
        <header className="resource-picker-header">
          <h2>{heading(options)}</h2>
          <button type="button" className="resource-picker-close" aria-label="Close" onClick={cancel}>
            ×
          </button>
        </header>

        <div className="resource-picker-search">
          <input
            type="search"
            value={search}
            placeholder={`Search ${options.type}s`}
            onChange={event => setSearch(event.target.value)}
            autoFocus
          />
        </div>

        <div className="resource-picker-body">
          {live && liveState === 'loading' && items.length === 0 ? (
            <p className="resource-picker-empty">Loading {options.type}s from the store…</p>
          ) : live && liveState === 'error' ? (
            <p className="resource-picker-empty">Could not load {options.type}s from the store (see console)</p>
          ) : items.length === 0 ? (
            <p className="resource-picker-empty">No {options.type}s found</p>
          ) : (
            <ul className="resource-picker-list">
              {items.map(item => {
                const id = String((item as { id: string }).id);
                const checked = selectedIds.includes(id);
                return (
                  <li key={id}>
                    <label className={`resource-picker-row${checked ? ' is-selected' : ''}`}>
                      <input
                        type={multiple ? 'checkbox' : 'radio'}
                        name="resource-picker"
                        checked={checked}
                        onChange={() => toggleId(id)}
                      />
                      <span className="resource-picker-thumb" aria-hidden="true">
                        {resourceThumb(item as MockProduct) ? (
                          <img src={resourceThumb(item as MockProduct)} alt="" />
                        ) : (
                          <span className="resource-picker-thumb-fallback" />
                        )}
                      </span>
                      <span className="resource-picker-copy">
                        <span className="resource-picker-title">{resourceTitle(item as { title?: string })}</span>
                        <span className="resource-picker-meta">{resourceMeta(item as MockProduct, options.type)}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="resource-picker-footer">
          <span className="resource-picker-count">
            {selectedIds.length} selected
          </span>
          <div className="resource-picker-actions">
            <button type="button" className="resource-picker-button" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="resource-picker-button is-primary"
              disabled={confirmDisabled}
              onClick={confirm}
            >
              {actionLabel(options)}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
