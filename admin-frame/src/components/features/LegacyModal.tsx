import { clickLegacyModalButton, closeLegacyModalFromAdmin, useLegacyModalStore, type LegacyModalButton } from "../../lib/legacyAppBridge";

function FooterButton({ button, primary }: { button: LegacyModalButton; primary?: boolean }) {
  const destructive = button.style === 'danger' || button.style === 'destructive';
  return (
    <button
      type="button"
      className={`mock-legacy-modal-button${primary ? ' is-primary' : ''}${destructive ? ' is-destructive' : ''}`}
      disabled={button.disabled || button.loading}
      onClick={() => clickLegacyModalButton(button.id)}
    >
      {button.loading ? '…' : button.label}
    </button>
  );
}

/** App Bridge v3 message modals (Modal.create with title/message/footer). */
export function LegacyModal() {
  const modals = useLegacyModalStore(state => state.modals);
  const modal = modals[modals.length - 1];
  if (!modal) return null;

  return (
    <div className="mock-legacy-modal" role="dialog" aria-modal="true" aria-label={modal.title || 'Modal'}>
      <button type="button" className="mock-legacy-modal-backdrop" aria-label="Close" onClick={() => closeLegacyModalFromAdmin(modal.id)} />
      <div className={`mock-legacy-modal-panel size-${(modal.size || 'small').toLowerCase()}`}>
        <div className="mock-legacy-modal-header">
          <h2>{modal.title}</h2>
          <button type="button" className="mock-legacy-modal-close" aria-label="Close" onClick={() => closeLegacyModalFromAdmin(modal.id)}>×</button>
        </div>
        {modal.message && <div className="mock-legacy-modal-body">{modal.message}</div>}
        {(modal.primary || modal.secondary.length > 0) && (
          <div className="mock-legacy-modal-footer">
            {modal.secondary.map(button => <FooterButton key={button.id} button={button} />)}
            {modal.primary && <FooterButton button={modal.primary} primary />}
          </div>
        )}
      </div>
    </div>
  );
}
