import { create } from "zustand";
import { DEFAULT_SYNTH_PARAMS, type SynthParams } from "../types/daw";

export interface DesignView {
  synth_params: SynthParams;
}

interface DesignViewState {
  /** All known design views: view_id → DesignView. */
  designViews: Record<string, DesignView>;
  /** The view_id the local user is currently editing. */
  activeViewId: string;
  /** Per-view audio sync toggle: view_id → enabled. */
  syncByView: Record<string, boolean>;

  /** Set the active design view (e.g. clicking another user's tab). */
  setActiveView: (viewId: string) => void;

  /** Initialize views from server state (on join). */
  initFromServer: (views: Record<string, DesignView>) => void;

  /** Ensure a view exists (creates with defaults if missing). */
  ensureView: (viewId: string) => void;

  /** Optimistic local update of synth params for a view. */
  patchView: (viewId: string, params: Partial<SynthParams>) => void;

  /** Handle remote design_view_update from another user. */
  handleRemoteUpdate: (viewId: string, synthParams: Partial<SynthParams>) => void;

  /** Get synth params for the active view. */
  getActiveParams: () => SynthParams;

  /** Toggle sync for a view (local state only — caller pushes to channel). */
  setSync: (viewId: string, enabled: boolean) => void;

  /** Get current sync state for a view. */
  getSync: (viewId: string) => boolean;

  /** Create a new named design view (returns the viewId). */
  createView: (viewId: string) => void;

  /** Remove a design view. */
  removeView: (viewId: string) => void;
}

export const useDesignViewStore = create<DesignViewState>((set, get) => ({
  designViews: {},
  activeViewId: "",
  syncByView: {},

  setActiveView: (viewId) => {
    get().ensureView(viewId);
    set({ activeViewId: viewId });
  },

  initFromServer: (views) => {
    const merged: Record<string, DesignView> = {};
    for (const [id, view] of Object.entries(views)) {
      merged[id] = {
        synth_params: { ...DEFAULT_SYNTH_PARAMS, ...view.synth_params },
      };
    }
    set((state) => ({
      designViews: { ...state.designViews, ...merged },
    }));
  },

  ensureView: (viewId) => {
    set((state) => {
      if (state.designViews[viewId]) return state;
      return {
        designViews: {
          ...state.designViews,
          [viewId]: { synth_params: { ...DEFAULT_SYNTH_PARAMS } },
        },
      };
    });
  },

  patchView: (viewId, params) => {
    set((state) => {
      const view = state.designViews[viewId] ?? {
        synth_params: { ...DEFAULT_SYNTH_PARAMS },
      };
      return {
        designViews: {
          ...state.designViews,
          [viewId]: {
            ...view,
            synth_params: { ...view.synth_params, ...params },
          },
        },
      };
    });
  },

  handleRemoteUpdate: (viewId, synthParams) => {
    set((state) => {
      const existing = state.designViews[viewId];
      const currentParams = existing?.synth_params ?? { ...DEFAULT_SYNTH_PARAMS };
      return {
        designViews: {
          ...state.designViews,
          [viewId]: {
            synth_params: { ...currentParams, ...synthParams },
          },
        },
      };
    });
  },

  getActiveParams: () => {
    const { designViews, activeViewId } = get();
    return designViews[activeViewId]?.synth_params ?? DEFAULT_SYNTH_PARAMS;
  },

  setSync: (viewId, enabled) => {
    set((state) => ({
      syncByView: { ...state.syncByView, [viewId]: enabled },
    }));
  },

  getSync: (viewId) => {
    return get().syncByView[viewId] ?? false;
  },

  createView: (viewId) => {
    set((state) => {
      if (state.designViews[viewId]) return state;
      return {
        designViews: {
          ...state.designViews,
          [viewId]: { synth_params: { ...DEFAULT_SYNTH_PARAMS } },
        },
        activeViewId: viewId,
      };
    });
  },

  removeView: (viewId) => {
    set((state) => {
      const { [viewId]: _, ...rest } = state.designViews;
      const { [viewId]: __, ...restSync } = state.syncByView;
      return {
        designViews: rest,
        syncByView: restSync,
        activeViewId: state.activeViewId === viewId
          ? Object.keys(rest)[0] ?? ""
          : state.activeViewId,
      };
    });
  },
}));
