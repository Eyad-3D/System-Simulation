import {
  DockviewReact,
  themeLight,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelProps,
} from "dockview-react";
import { useUIStore } from "../store/uiStore";
import { ComponentsPanel } from "./panels/ComponentsPanel";
import { ElementsPanel } from "./panels/ElementsPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { MessagesPanel } from "./panels/MessagesPanel";
import { DataChecksPanel } from "./panels/DataChecksPanel";
import { LayerConfigPanel } from "./panels/LayerConfigPanel";
import { DataBusPanel } from "./panels/DataBusPanel";
import { ResultsPanel } from "./panels/ResultsPanel";
import { MonitorsPanel } from "./panels/MonitorsPanel";
import { TopologyCanvas } from "./canvas/TopologyCanvas";

const ssTheme: DockviewTheme = {
  ...themeLight,
  name: "simstudio",
  className: `${themeLight.className} dockview-theme-ss`,
};

const wrap =
  (Component: React.ComponentType) =>
  // eslint-disable-next-line react/display-name
  (_props: IDockviewPanelProps) => (
    <div className="h-full w-full overflow-hidden bg-[color:var(--ss-panel)]">
      <Component />
    </div>
  );

const components = {
  components: wrap(ComponentsPanel),
  elements: wrap(ElementsPanel),
  topology: wrap(TopologyCanvas),
  results: wrap(ResultsPanel),
  monitors: wrap(MonitorsPanel),
  properties: wrap(PropertiesPanel),
  messages: wrap(MessagesPanel),
  "data-checks": wrap(DataChecksPanel),
  "layer-config": wrap(LayerConfigPanel),
  "data-bus": wrap(DataBusPanel),
};

function onReady(event: DockviewReadyEvent) {
  const api = event.api;
  useUIStore.getState().setDockApi(api);

  const componentsPanel = api.addPanel({
    id: "components",
    component: "components",
    title: "Components",
  });
  api.addPanel({
    id: "elements",
    component: "elements",
    title: "Elements",
    position: { referencePanel: "components", direction: "within" },
  });
  api.addPanel({
    id: "topology",
    component: "topology",
    title: "Topology",
    position: { referencePanel: "components", direction: "right" },
  });
  api.addPanel({
    id: "results",
    component: "results",
    title: "Results",
    position: { referencePanel: "topology", direction: "within" },
  });
  api.addPanel({
    id: "monitors",
    component: "monitors",
    title: "Monitors",
    position: { referencePanel: "topology", direction: "within" },
  });
  const propertiesPanel = api.addPanel({
    id: "properties",
    component: "properties",
    title: "Properties",
    position: { referencePanel: "topology", direction: "right" },
  });
  const messagesPanel = api.addPanel({
    id: "messages",
    component: "messages",
    title: "Messages",
    position: { direction: "below" },
  });
  api.addPanel({
    id: "data-checks",
    component: "data-checks",
    title: "Data Checks",
    position: { referencePanel: "messages", direction: "within" },
  });
  api.addPanel({
    id: "layer-config",
    component: "layer-config",
    title: "Layer Configurations",
    position: { referencePanel: "messages", direction: "within" },
  });
  api.addPanel({
    id: "data-bus",
    component: "data-bus",
    title: "Data Bus Connections",
    position: { referencePanel: "messages", direction: "within" },
  });

  componentsPanel.api.setSize({ width: 265 });
  propertiesPanel.api.setSize({ width: 305 });
  messagesPanel.api.setSize({ height: 235 });

  api.getPanel("components")?.api.setActive();
  api.getPanel("messages")?.api.setActive();
  api.getPanel("topology")?.api.setActive();
}

export function DockLayout() {
  return (
    <DockviewReact
      components={components}
      onReady={onReady}
      theme={ssTheme}
    />
  );
}
