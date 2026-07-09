import { create } from 'zustand';
import type { Mapping, Run } from '../services/mapping-service';

interface MappingState {
  mappings: Mapping[];
  selectedMapping: Mapping | null;
  runs: Run[];
  isLoading: boolean;
  error: string | null;
  
  setMappings: (mappings: Mapping[]) => void;
  addMapping: (mapping: Mapping) => void;
  updateMapping: (mapping: Mapping) => void;
  removeMapping: (mappingId: string) => void;
  setSelectedMapping: (mapping: Mapping | null) => void;
  setRuns: (runs: Run[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const useMappingStore = create<MappingState>((set) => ({
  mappings: [],
  selectedMapping: null,
  runs: [],
  isLoading: false,
  error: null,
  
  setMappings: (mappings) => set({ mappings }),
  addMapping: (mapping) => set((state) => ({ 
    mappings: [...state.mappings, mapping] 
  })),
  updateMapping: (mapping) => set((state) => ({
    mappings: state.mappings.map((m) => 
      m.id === mapping.id ? mapping : m
    ),
    selectedMapping: state.selectedMapping?.id === mapping.id 
      ? mapping 
      : state.selectedMapping,
  })),
  removeMapping: (mappingId) => set((state) => ({
    mappings: state.mappings.filter((m) => m.id !== mappingId),
    selectedMapping: state.selectedMapping?.id === mappingId 
      ? null 
      : state.selectedMapping,
  })),
  setSelectedMapping: (mapping) => set({ selectedMapping: mapping }),
  setRuns: (runs) => set({ runs }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
}));
