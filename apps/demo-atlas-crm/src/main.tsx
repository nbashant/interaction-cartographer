import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type View = "dashboard" | "customers" | "pipeline" | "settings";
type SettingsTab = "profile" | "billing" | "notifications";

const customers = [
  { name: "Northstar Labs", value: "$84k", stage: "Expansion", owner: "Mina" },
  { name: "Cobalt Health", value: "$42k", stage: "Pilot", owner: "Dev" },
  { name: "Sierra Supply", value: "$19k", stage: "Renewal", owner: "Ari" }
];

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("profile");
  const [createOpen, setCreateOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pipelineBlank, setPipelineBlank] = useState(false);
  const [toast, setToast] = useState(false);

  const mainBlank = view === "pipeline" && pipelineBlank;

  return (
    <div className="atlas-shell">
      <aside className="sidebar">
        <div className="logo-mark">A</div>
        <strong>Atlas CRM</strong>
        <nav aria-label="Primary">
          <button data-cartograph="nav-dashboard" className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            Dashboard
          </button>
          <button data-cartograph="nav-customers" className={view === "customers" ? "active" : ""} onClick={() => setView("customers")}>
            Customers
          </button>
          <button data-cartograph="nav-pipeline" className={view === "pipeline" ? "active" : ""} onClick={() => setView("pipeline")}>
            Pipeline
          </button>
          <button data-cartograph="nav-settings" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
            Settings
          </button>
        </nav>
      </aside>

      <div className={`mobile-drawer ${mobileOpen ? "open" : ""}`} role="dialog" aria-modal={mobileOpen ? "true" : undefined}>
        <button data-cartograph="mobile-dashboard" onClick={() => setView("dashboard")}>Dashboard</button>
        <button data-cartograph="mobile-customers" onClick={() => setView("customers")}>Customers</button>
        <button data-cartograph="mobile-settings" onClick={() => setView("settings")}>Settings</button>
        <p>Long mobile workspace label that should not fit cleanly at narrow widths</p>
      </div>

      <main className="content" data-cartograph-main data-cartograph-blank={mainBlank ? "true" : "false"}>
        <header className="topline">
          <button className="mobile-menu" data-cartograph="mobile-menu" aria-label="Open mobile navigation" onClick={() => setMobileOpen((value) => !value)}>
            Menu
          </button>
          <div>
            <h1>{headingFor(view, pipelineBlank)}</h1>
            <span>Revenue workspace · local demo fixture</span>
          </div>
          <button data-cartograph="create-customer" className="primary" onClick={() => setCreateOpen(true)}>
            Create customer
          </button>
        </header>

        {view === "dashboard" ? <Dashboard setView={setView} setToast={setToast} /> : null}
        {view === "customers" ? <Customers setCreateOpen={setCreateOpen} /> : null}
        {view === "pipeline" ? <Pipeline blank={pipelineBlank} setBlank={setPipelineBlank} /> : null}
        {view === "settings" ? <Settings tab={settingsTab} setTab={setSettingsTab} /> : null}
      </main>

      {createOpen ? <CreateCustomerModal /> : null}
      {toast ? <div className="toast" role="status">Customer sync failed. Try again later.</div> : null}
    </div>
  );
}

function Dashboard({ setView, setToast }: { setView: (view: View) => void; setToast: (value: boolean) => void }) {
  return (
    <section className="dashboard-grid">
      <article className="metric-card">
        <span>Pipeline</span>
        <strong>$145k</strong>
        <button data-cartograph="dashboard-pipeline" onClick={() => setView("pipeline")}>Review deals</button>
      </article>
      <article className="metric-card">
        <span>Customers</span>
        <strong>38</strong>
        <button data-cartograph="dashboard-customers" onClick={() => setView("customers")}>Open list</button>
      </article>
      <article className="metric-card">
        <span>Tasks</span>
        <strong>12</strong>
        <button data-cartograph="dashboard-toast" onClick={() => setToast(true)}>Sync tasks</button>
      </article>
      <section className="activity-panel">
        <h2>Today</h2>
        <p>Northstar Labs moved to expansion review.</p>
        <p>Cobalt Health requested security follow-up.</p>
      </section>
    </section>
  );
}

function Customers({ setCreateOpen }: { setCreateOpen: (open: boolean) => void }) {
  return (
    <section className="table-panel">
      <div className="section-heading">
        <h2>Customer list</h2>
        <button data-cartograph="customer-list-create" onClick={() => setCreateOpen(true)}>New customer</button>
      </div>
      <div className="customer-table">
        {customers.map((customer) => (
          <button data-cartograph={`customer-${customer.name.toLowerCase().replace(/\s+/g, "-")}`} key={customer.name} className="customer-row">
            <strong>{customer.name}</strong>
            <span>{customer.stage}</span>
            <span>{customer.owner}</span>
            <em>{customer.value}</em>
          </button>
        ))}
      </div>
    </section>
  );
}

function Pipeline({ blank, setBlank }: { blank: boolean; setBlank: (blank: boolean) => void }) {
  if (blank) {
    return <section className="blank-workspace" aria-label="Blank pipeline panel" />;
  }

  return (
    <section className="pipeline-board">
      {["Qualified", "Pilot", "Expansion"].map((column) => (
        <article key={column} className="pipeline-column">
          <h2>{column}</h2>
          <button data-cartograph={`pipeline-card-${column.toLowerCase()}`} className="deal-card" onClick={() => column === "Pilot" && setBlank(true)}>
            <strong>{column === "Pilot" ? "Cobalt Health" : column === "Expansion" ? "Northstar Labs" : "Juniper Field"}</strong>
            <span>{column === "Pilot" ? "Open action panel" : "View account"}</span>
          </button>
        </article>
      ))}
    </section>
  );
}

function Settings({ tab, setTab }: { tab: SettingsTab; setTab: (tab: SettingsTab) => void }) {
  return (
    <section className="settings-panel">
      <div className="tab-row" role="tablist" aria-label="Settings tabs">
        <button role="tab" data-cartograph="settings-profile" aria-selected={tab === "profile"} onClick={() => setTab("profile")}>Profile</button>
        <button
          role="tab"
          data-cartograph="settings-billing"
          aria-selected={tab === "billing"}
          onClick={() => {
            console.error("Billing tab exploded: missing billing plan id");
            setTab("billing");
          }}
        >
          Billing
        </button>
        <button role="tab" data-cartograph="settings-notifications" aria-selected={tab === "notifications"} onClick={() => setTab("notifications")}>Notifications</button>
      </div>
      <div className="settings-card">
        <h2>{tab === "billing" ? "Billing settings" : tab === "notifications" ? "Notification settings" : "Profile settings"}</h2>
        <label>
          Workspace name
          <input data-cartograph="workspace-name" defaultValue="Atlas Revenue" />
        </label>
        <label>
          Owner email
          <input data-cartograph="owner-email" defaultValue="ops@example.com" />
        </label>
        <button className="icon-only" data-cartograph="settings-save">
          <span aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function CreateCustomerModal() {
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div className="modal-heading">
          <h2 id="create-title">Create customer</h2>
          <button data-cartograph="modal-close" className="close-button" onClick={() => undefined} aria-label="Close create customer modal">
            Close
          </button>
        </div>
        <label>
          Customer name
          <input data-cartograph="customer-name" placeholder="Acme Inc." />
        </label>
        <label>
          Owner email
          <input data-cartograph="customer-email" placeholder="owner@example.com" />
        </label>
        <button data-cartograph="modal-save" className="primary">Save customer</button>
      </section>
    </div>
  );
}

function headingFor(view: View, blank: boolean): string {
  if (view === "customers") return "Customer list";
  if (view === "pipeline") return blank ? "Pipeline board" : "Pipeline board";
  if (view === "settings") return "Settings tabs";
  return "Dashboard";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
