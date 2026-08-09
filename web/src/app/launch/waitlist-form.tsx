"use client";

import { useState } from "react";

import { useWalletAddress } from "@/components/wallet/connect-button";

type State = "idle" | "sending" | "done" | "error";

export function WaitlistForm() {
  const wallet = useWalletAddress();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    setMessage("");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, wallet: wallet ?? "" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "That did not work.");
      setState("done");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "That did not work.");
    }
  }

  if (state === "done") {
    return (
      <div className="card flex flex-col gap-1 px-4 py-4">
        <p className="num text-sm font-semibold">
          <span className="grad-num">You&apos;re on the list.</span>
        </p>
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          One email when the creator flow is real. Not before, and nothing
          else.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="meta">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="num h-12 rounded-2xl border border-rule bg-paper px-4 text-sm text-ink outline-none placeholder:text-faint"
        />
      </label>

      <p className="text-[0.6875rem] leading-relaxed text-faint">
        {wallet
          ? `We will also store the connected wallet ${wallet.slice(0, 4)}…${wallet.slice(-4)} so we can whitelist it for the first creator cohort.`
          : "Connect a wallet first and we will store it too, so you can be whitelisted for the first creator cohort."}
      </p>

      <button
        type="submit"
        disabled={state === "sending"}
        className="btn btn-grad w-full disabled:opacity-50"
      >
        {state === "sending" ? "Sending" : "Join the waitlist"}
      </button>

      {state === "error" ? (
        <p role="alert" className="text-[0.8125rem] text-neg">
          {message}
        </p>
      ) : null}
    </form>
  );
}
