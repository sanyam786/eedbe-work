import { useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type OrgInfo } from "./api";
import { Icon, Loading, useApi, useToast, useWs, WorkspaceCtx, Notice } from "./ui";
import { Login, Signup, InviteAccept, NewWorkspace } from "./pages/Auth";
import { Home } from "./pages/Home";
import { Overview } from "./pages/Overview";
import { Customers } from "./pages/Customers";
import { Documents } from "./pages/Documents";
import { Requests } from "./pages/Requests";
import { Activity } from "./pages/Activity";
import { TestChat } from "./pages/TestChat";
import { WhatsAppSetup } from "./pages/WhatsAppSetup";
import { StorageSetup } from "./pages/StorageSetup";
import { AssistantSetup } from "./pages/AssistantSetup";
import { DocTypes } from "./pages/DocTypes";
import { BusinessSettings, TeamSettings, AiSettings } from "./pages/WorkspaceSettings";

export interface Me { user: { id: string; name: string; email: string } | null; orgs: { id: string; name: string; role: string; industry: string }[] }

export function App() {
  const me = useApi<Me>("/api/auth/me");
  if (!me.data && me.loading) return <Loading />;
  const refresh = me.reload;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login onDone={refresh} />} />
        <Route path="/signup" element={<Signup onDone={refresh} />} />
        <Route path="/invite/:token" element={<InviteAccept me={me.data} onDone={refresh} />} />
        <Route path="/new" element={me.data?.user ? <NewWorkspace onDone={refresh} hasOrgs={(me.data?.orgs.length ?? 0) > 0} /> : <Navigate to="/login" />} />
        <Route path="/w/:orgId/*" element={me.data?.user ? <Workspace me={me.data} /> : <Navigate to="/login" />} />
        <Route path="*" element={<Start me={me.data} />} />
      </Routes>
    </BrowserRouter>
  );
}

function Start({ me }: { me?: Me }) {
  if (!me?.user) return <Navigate to="/login" replace />;
  const last = localStorage.getItem("eedbe:lastOrg");
  const org = me.orgs.find((o) => o.id === last) ?? me.orgs[0];
  return <Navigate to={org ? `/w/${org.id}` : "/new"} replace />;
}

function Workspace({ me }: { me: Me }) {
  const { orgId } = useParams();
  const org = useApi<OrgInfo>(`/api/orgs/${orgId}`, [orgId]);
  const overview = useApi<any>(org.data?.features.whatsapp_docbot ? `/api/orgs/${orgId}/docbot/overview` : null, [orgId, org.data?.features.whatsapp_docbot]);
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => { if (orgId) localStorage.setItem("eedbe:lastOrg", orgId); }, [orgId]);
  // Refresh counts when moving between pages
  useEffect(() => { if (org.data?.features.whatsapp_docbot) void overview.reload(); }, [loc.pathname]); // eslint-disable-line

  if (org.error) return <div className="main"><Notice kind="error">{org.error}</Notice><p style={{ marginTop: 12 }}><a href="/">Back</a></p></div>;
  if (!org.data) return <Loading />;
  const o = org.data;
  const base = `/w/${o.id}`;
  const isAdmin = o.role !== "staff";
  const counts = overview.data?.counts;
  const docbot = o.features.whatsapp_docbot;

  const logout = async () => { await api.post("/api/auth/logout"); window.location.href = "/login"; };

  return (
    <WorkspaceCtx.Provider value={{ org: o, reload: async () => { await org.reload(); await overview.reload(); }, base, isAdmin, toast: toast.show }}>
      <div className={`shell${menu ? " menu-open" : ""}`}>
        <aside className="sidebar">
          <div className="brand"><span className="brand-mark">e</span> eedbe Work</div>
          <div className="org-switch">
            <select value={o.id} aria-label="Workspace" onChange={(e) => e.target.value === "new" ? nav("/new") : nav(`/w/${e.target.value}`)}>
              {me.orgs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value="new">+ New workspace…</option>
            </select>
          </div>
          <nav className="nav">
            <NavLink to={base} end><Icon.grid /> Home</NavLink>
            {docbot && <>
              <div className="nav-group">WhatsApp Documents</div>
              <NavLink to={`${base}/whatsapp`} end><Icon.home /> Dashboard</NavLink>
              <NavLink to={`${base}/whatsapp/customers`}><Icon.users /> Customers</NavLink>
              <NavLink to={`${base}/whatsapp/documents`}><Icon.file /> Documents{counts?.review ? <span className="count">{counts.review}</span> : null}</NavLink>
              <NavLink to={`${base}/whatsapp/requests`}><Icon.inbox /> Requests{counts && counts.waiting + counts.approvals ? <span className="count">{counts.waiting + counts.approvals}</span> : null}</NavLink>
              <NavLink to={`${base}/whatsapp/activity`}><Icon.list /> Activity</NavLink>
              <NavLink to={`${base}/whatsapp/test-chat`}><Icon.chat /> Test chat</NavLink>
              <div className="nav-group">Assistant setup</div>
              <NavLink to={`${base}/whatsapp/setup/whatsapp`}><Icon.plug /> WhatsApp number</NavLink>
              <NavLink to={`${base}/whatsapp/setup/storage`}><Icon.cloud /> Document storage</NavLink>
              <NavLink to={`${base}/whatsapp/setup/assistant`}><Icon.sliders /> Replies & rules</NavLink>
              <NavLink to={`${base}/whatsapp/setup/doc-types`}><Icon.tag /> Document types</NavLink>
            </>}
            <div className="nav-group">Workspace</div>
            <NavLink to={`${base}/settings`} end><Icon.gear /> Business profile</NavLink>
            <NavLink to={`${base}/settings/team`}><Icon.team /> Team</NavLink>
            <NavLink to={`${base}/settings/ai`}><Icon.spark /> AI</NavLink>
          </nav>
          <div className="sidebar-foot">
            <div style={{ color: "#fff", fontWeight: 600 }}>{me.user?.name}</div>
            <div>{me.user?.email} · {o.role}</div>
            <button onClick={logout} style={{ marginTop: 6 }}>Sign out</button>
          </div>
        </aside>
        <div>
          <div className="mobile-top"><button onClick={() => setMenu(!menu)} aria-label="Menu">☰</button><b>{o.name}</b></div>
          <main className="main">
            <Routes>
              <Route index element={<Home overview={overview.data} />} />
              {docbot && <>
                <Route path="whatsapp" element={<Overview data={overview.data} />} />
                <Route path="whatsapp/customers" element={<Customers />} />
                <Route path="whatsapp/documents" element={<Documents />} />
                <Route path="whatsapp/requests" element={<Requests />} />
                <Route path="whatsapp/activity" element={<Activity />} />
                <Route path="whatsapp/test-chat" element={<TestChat />} />
                <Route path="whatsapp/setup/whatsapp" element={<AdminOnly><WhatsAppSetup /></AdminOnly>} />
                <Route path="whatsapp/setup/storage" element={<AdminOnly><StorageSetup /></AdminOnly>} />
                <Route path="whatsapp/setup/assistant" element={<AdminOnly><AssistantSetup /></AdminOnly>} />
                <Route path="whatsapp/setup/doc-types" element={<DocTypes />} />
              </>}
              <Route path="settings" element={<BusinessSettings />} />
              <Route path="settings/team" element={<TeamSettings />} />
              <Route path="settings/ai" element={<AdminOnly><AiSettings /></AdminOnly>} />
              <Route path="*" element={<Navigate to={base} replace />} />
            </Routes>
          </main>
        </div>
        {menu && <div className="overlay" onClick={() => setMenu(false)} />}
      </div>
      {toast.node}
    </WorkspaceCtx.Provider>
  );
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useWs();
  if (!isAdmin) return <Notice kind="warn">Only workspace admins can change this. Ask an admin or the owner.</Notice>;
  return <>{children}</>;
}
