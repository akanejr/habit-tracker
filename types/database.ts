/**
 * Hand-written database types matching supabase/migrations/.
 *
 * Once the schema stabilises, regenerate with the Supabase CLI:
 *   supabase gen types typescript --project-ref retkelaxegvlkuzhgosz > types/database.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      habits: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          description: string | null;
          frequency: "daily" | "weekly" | "custom";
          target_per_week: number | null;
          preferred_time: string | null;
          color: string | null;
          icon: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          description?: string | null;
          frequency?: "daily" | "weekly" | "custom";
          target_per_week?: number | null;
          preferred_time?: string | null;
          color?: string | null;
          icon?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          description?: string | null;
          frequency?: "daily" | "weekly" | "custom";
          target_per_week?: number | null;
          preferred_time?: string | null;
          color?: string | null;
          icon?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      habit_versions: {
        Row: {
          id: number;
          habit_id: string;
          user_id: string;
          recorded_at: string;
          is_baseline: boolean;
          name: string;
          description: string | null;
          frequency: string;
          target_per_week: number | null;
          preferred_time: string | null;
          color: string | null;
          icon: string | null;
          is_active: boolean;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      habit_logs: {
        Row: {
          id: string;
          habit_id: string;
          user_id: string;
          completed_on: string;
          note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          habit_id: string;
          user_id: string;
          completed_on: string;
          note?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          habit_id?: string;
          user_id?: string;
          completed_on?: string;
          note?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
