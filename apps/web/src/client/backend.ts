import { createContext, createElement, useContext, type ReactNode } from "react";
import type { Backend } from "../domain/backend.ts";

const BackendContext = createContext<Backend | undefined>(undefined);

export const BackendProvider = ({
  backend,
  children,
}: Readonly<{ backend: Backend; children: ReactNode }>): ReactNode =>
  createElement(BackendContext.Provider, { value: backend }, children);

export const useBackend = (): Backend => {
  const backend = useContext(BackendContext);
  if (backend === undefined) {
    throw new Error("useBackend は BackendProvider の中で使う");
  }
  return backend;
};
