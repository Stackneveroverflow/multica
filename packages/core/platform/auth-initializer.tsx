"use client";

import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApi } from "../api";
import { useAuthStore } from "../auth";
import {
  captureSignupSource,
  identify as identifyAnalytics,
  initAnalytics,
  resetAnalytics,
} from "../analytics";
import { configStore } from "../config";
import { workspaceKeys } from "../workspace/queries";
import { createLogger } from "../logger";
import { defaultStorage } from "./storage";
import { setCurrentWorkspace } from "./workspace-storage";
import type { ClientIdentity } from "./types";
import type { StorageAdapter } from "../types/storage";
import type { User } from "../types";
import type { AppConfigResponse } from "../api/schemas";

const logger = createLogger("auth");

export function AuthInitializer({
  children,
  onLogin,
  onLogout,
  storage = defaultStorage,
  cookieAuth,
  identity,
}: {
  children: ReactNode;
  onLogin?: () => void;
  onLogout?: () => void;
  storage?: StorageAdapter;
  cookieAuth?: boolean;
  identity?: ClientIdentity;
}) {
  const qc = useQueryClient();

  useEffect(() => {
    const api = getApi();

    // Stamp attribution before anything else — the signup event (server-side)
    // reads this cookie, so it has to be present before the user hits submit.
    captureSignupSource();

    const applyConfig = (cfg: AppConfigResponse) => {
      if (cfg.cdn_domain) configStore.getState().setCdnDomain(cfg.cdn_domain);
      configStore.getState().setAuthConfig({
        authMode: cfg.auth_mode || "auth",
        allowSignup: cfg.allow_signup,
        googleClientId: cfg.google_client_id,
        // Old servers omit this field — treat that as "creation allowed"
        // (the managed-cloud default) rather than blocking the UI.
        workspaceCreationDisabled: cfg.workspace_creation_disabled === true,
      });
      configStore.getState().setDaemonConfig({
        daemonServerUrl: cfg.daemon_server_url,
        daemonAppUrl: cfg.daemon_app_url,
      });
      if (cfg.posthog_key) {
        initAnalytics({
          key: cfg.posthog_key,
          host: cfg.posthog_host || "",
          appVersion: identity?.version,
          environment: cfg.analytics_environment,
        });
      }
    };

    const onAuthSuccess = (user: User) => {
      onLogin?.();
      useAuthStore.setState({ user, isLoading: false });
      identifyAnalytics(user.id, { email: user.email, name: user.name });
    };

    const onAuthFailure = () => {
      onLogout?.();
      resetAnalytics();
      useAuthStore.setState({ user: null, isLoading: false });
    };

    const initializeAuthenticatedSession = (cfg?: AppConfigResponse) => {
      const localAuth = cfg?.auth_mode === "local";
      if (localAuth) {
        api.setToken(null);
        Promise.all([api.getMe(), api.listWorkspaces()])
          .then(([user, wsList]) => {
            onAuthSuccess(user);
            qc.setQueryData(workspaceKeys.list(), wsList);
          })
          .catch((err) => {
            logger.error("local auth init failed", err);
            onAuthFailure();
          });
        return;
      }

      if (cookieAuth) {
      // Cookie mode: the HttpOnly cookie is sent automatically by the browser.
      // Call the API to check if the session is still valid.
      //
      // Seed the workspace list into React Query so the URL-driven layout can
      // resolve the slug without a second fetch. The active workspace itself
      // is derived from the URL by [workspaceSlug]/layout.tsx — no imperative
      // selection here.
        Promise.all([api.getMe(), api.listWorkspaces()])
          .then(([user, wsList]) => {
            onAuthSuccess(user);
            qc.setQueryData(workspaceKeys.list(), wsList);
          })
          .catch((err) => {
            logger.error("cookie auth init failed", err);
            onAuthFailure();
          });
        return;
      }

      // Token mode: read from localStorage (Electron / legacy).
      const token = storage.getItem("multica_token");
      if (!token) {
        onLogout?.();
        useAuthStore.setState({ isLoading: false });
        return;
      }

      api.setToken(token);

      Promise.all([api.getMe(), api.listWorkspaces()])
        .then(([user, wsList]) => {
          onAuthSuccess(user);
          // Seed React Query cache so the URL-driven layout can resolve the
          // slug without a second fetch.
          qc.setQueryData(workspaceKeys.list(), wsList);
        })
        .catch((err) => {
          logger.error("auth init failed", err);
          api.setToken(null);
          setCurrentWorkspace(null, null);
          storage.removeItem("multica_token");
          onAuthFailure();
        });
    };

    api
      .getConfig()
      .then((cfg) => {
        applyConfig(cfg);
        initializeAuthenticatedSession(cfg);
      })
      .catch(() => {
        initializeAuthenticatedSession();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{children}</>;
}
