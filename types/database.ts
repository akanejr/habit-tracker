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
      habit_sessions: {
        Row: { id: string; user_id: string; habit_id: string; source: "timed" | "quick" | "legacy"; status: "running" | "paused" | "completed" | "cancelled"; created_at: string; started_at: string | null; completed_at: string | null; recording_mode: string; completed_on: string | null; duration_ms: number | null; estimated_ms: number | null; note: string | null; start_version_id: number | null; completion_version_id: number | null; legacy_log_id: string | null };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      habit_session_segments: {
        Row: { id: number; session_id: string; user_id: string; started_at: string; ended_at: string | null };
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
    Functions: {
      bloom_create_habit: { Args: { p_request_id: string; p_name: string; p_description?: string | null; p_time?: string | null }; Returns: Json };
      bloom_update_habit: { Args: { p_request_id: string; p_habit_id: string; p_name: string; p_description?: string | null; p_time?: string | null }; Returns: Json };
      bloom_archive_habit: { Args: { p_request_id: string; p_habit_id: string }; Returns: Json };
      bloom_start_session: { Args: { p_request_id: string; p_habit_id: string }; Returns: Json };
      bloom_pause_session: { Args: { p_request_id: string; p_session_id: string }; Returns: Json };
      bloom_resume_session: { Args: { p_request_id: string; p_session_id: string }; Returns: Json };
      bloom_complete_session: { Args: { p_request_id: string; p_session_id: string }; Returns: Json };
      bloom_cancel_session: { Args: { p_request_id: string; p_session_id: string }; Returns: Json };
      bloom_quick_log: { Args: { p_request_id: string; p_habit_id: string; p_date: string; p_estimated_ms?: number | null; p_note?: string | null }; Returns: Json };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
