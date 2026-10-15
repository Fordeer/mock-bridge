import { useEffect } from "react"
import { EmbeddedApp } from "./components/EmbeddedApp"
import { Modal } from "./components/features/Modal"
import { LegacyModal } from "./components/features/LegacyModal"
import { Loading } from "./components/features/Loading"
import { ResourcePicker } from "./components/features/ResourcePicker"
import { Frame } from "./components/Frame"
import { Toast } from "./components/features/Toast"
import { installModalMessageRelay } from "./lib/embeddedFrame"

function App() {
  useEffect(() => {
    installModalMessageRelay()
  }, [])

  return (
    <>
      <Frame>
        <Loading />
        <EmbeddedApp />
      </Frame>
      {/* Outside admin-shell so large/max overlays cover nav + title bar */}
      <Modal />
      <LegacyModal />
      <ResourcePicker />
      {/* Last + own fixed layer: toasts stay above modals / max modals like Shopify */}
      <Toast />
    </>
  )
}

export default App
