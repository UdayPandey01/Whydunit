import Link from "next/link";
export function Nav() {
  return (
    <nav className="nav">
      <div className="in">
        <Link href="/" className="brand" style={{ color: "var(--ink)" }}>
          <span className="beacon" /> WhyDunit
        </Link>
        <div style={{ display: "flex", gap: 22 }}>
          <Link href="/">Story</Link>
          <Link href="/dashboard">Dashboard</Link>
          <a href="https://github.com" target="_blank" rel="noreferrer">Source</a>
        </div>
      </div>
    </nav>
  );
}
