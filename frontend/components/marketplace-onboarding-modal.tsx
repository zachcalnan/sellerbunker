"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMarketplace } from "@/contexts/marketplace-context";
import { SB_OPEN_MARKETPLACE_SELECTOR_EVENT } from "./marketplace-selector";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * After VAT onboarding, if the org has no base marketplace yet, opens the sidebar
 * flag dropdown once (per SPA session) so the user picks a default there — not in a second modal or on connect-amazon.
 */
export function MarketplaceOnboardingModal() {
  const { isSignedIn, getToken } = useAuth();
  const { marketplaces, refreshMarketplaces } = useMarketplace();
  const [vatDone, setVatDone] = useState(false);
  const [vatLoaded, setVatLoaded] = useState(false);
  const dispatchedOpenRef = useRef(false);

  const hasBase = useMemo(() => marketplaces.some((m) => m.isBase), [marketplaces]);

  const checkVat = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken({ template: "backend" });
      if (!token) return;
      const vatRes = await fetch(`${BASE_URL}/api/orgs/vat-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!vatRes.ok) return;
      const vatData = (await vatRes.json()) as { vatRegistrationType?: string | null };
      setVatDone(Boolean(vatData.vatRegistrationType));
    } catch {
      // ignore
    } finally {
      setVatLoaded(true);
    }
  }, [getToken, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) {
      setVatLoaded(false);
      setVatDone(false);
      dispatchedOpenRef.current = false;
      return;
    }
    setVatLoaded(false);
    void checkVat();
  }, [isSignedIn, checkVat]);

  useEffect(() => {
    const onVatComplete = () => {
      void refreshMarketplaces().then(() => void checkVat());
    };
    window.addEventListener("sellerbunker-vat-onboarding-complete", onVatComplete);
    return () => window.removeEventListener("sellerbunker-vat-onboarding-complete", onVatComplete);
  }, [refreshMarketplaces, checkVat]);

  useEffect(() => {
    if (hasBase) {
      dispatchedOpenRef.current = false;
    }
  }, [hasBase]);

  useEffect(() => {
    if (
      !vatLoaded ||
      !isSignedIn ||
      !vatDone ||
      hasBase ||
      marketplaces.length === 0 ||
      dispatchedOpenRef.current
    ) {
      return;
    }
    dispatchedOpenRef.current = true;
    window.dispatchEvent(new Event(SB_OPEN_MARKETPLACE_SELECTOR_EVENT));
  }, [vatLoaded, isSignedIn, vatDone, hasBase, marketplaces.length]);

  return null;
}
