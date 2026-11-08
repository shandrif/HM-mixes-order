import { lazy, Suspense } from "react";
import { useLocation } from "./router";
import StorePage from "./pages/StorePage";

const AdminApp = lazy(() => import("./pages/admin/AdminApp"));

export default function App() {
  const { path } = useLocation();
  if (path.startsWith("/admin"))
    return (
      <Suspense fallback={<div className="center-msg">Loading…</div>}>
        <AdminApp />
      </Suspense>
    );
  return <StorePage />;
}
