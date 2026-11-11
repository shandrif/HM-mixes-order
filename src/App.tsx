import { lazy, Suspense } from "react";
import { useLocation } from "./router";
import StorePage from "./pages/StorePage";

const SheetPreview = lazy(() => import("./pages/SheetPreview"));

const AdminApp = lazy(() => import("./pages/admin/AdminApp"));

function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <div className="amb-warm">
        <i />
        <i />
        <i />
      </div>
      <div className="amb-cool">
        <i />
        <i />
      </div>
      <b className="amb-cursor" />
    </div>
  );
}

export default function App() {
  return (
    <>
      <Ambient />
      <Routes />
    </>
  );
}

function Routes() {
  const { path } = useLocation();
  if (path.startsWith("/admin"))
    return (
      <Suspense fallback={<div className="center-msg">Loading…</div>}>
        <AdminApp />
      </Suspense>
    );
  if (path.startsWith("/sheet"))
    return (
      <Suspense fallback={<div className="center-msg">Loading…</div>}>
        <SheetPreview />
      </Suspense>
    );
  return <StorePage />;
}
