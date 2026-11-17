import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <main className="container">
      <div className="card">
        <h1>Authentication error</h1>
        <p>
          Something went wrong while signing you in. The link may have expired
          or already been used.
        </p>
        <p>
          <Link href="/">← Back to home</Link>
        </p>
      </div>
    </main>
  );
}
