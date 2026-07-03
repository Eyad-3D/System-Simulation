import { useEffect } from "react";
import { DockLayout } from "./components/DockLayout";
import { Ribbon } from "./components/Ribbon";
import { StatusBar } from "./components/StatusBar";
import { useProjectStore } from "./store/projectStore";

let initStarted = false;

export default function App() {
  const loaded = useProjectStore((s) => s.loaded);

  useEffect(() => {
    if (!initStarted) {
      initStarted = true;
      void useProjectStore.getState().init();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;
      const store = useProjectStore.getState();
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void store.saveRemote();
      } else if (!typing && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (!typing && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        store.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Ribbon />
      <div className="min-h-0 flex-1 p-1">
        {loaded ? (
          <DockLayout />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-[color:var(--ss-text-dim)]">
            Loading SimStudio…
          </div>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
