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
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
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
        Relationships: [
          {
            foreignKeyName: "habits_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
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
        Relationships: [
          {
            foreignKeyName: "habit_logs_habit_id_fkey";
            columns: ["habit_id"];
            referencedRelation: "habits";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_logs_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
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
        Relationships: [
          {
            foreignKeyName: "habit_versions_habit_id_fkey";
            columns: ["habit_id", "user_id"];
            referencedRelation: "habits";
            referencedColumns: ["id", "user_id"];
          }
        ];
      };
      habit_sessions: {
        Row: {
          id: string;
          user_id: string;
          habit_id: string;
          source: "timed" | "quick" | "legacy";
          status: "running" | "paused" | "completed" | "cancelled";
          recording_mode: "timer" | "quick" | "legacy";
          completed_on: string | null;
          duration_ms: number | null;
          estimated_ms: number | null;
          note: string | null;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
          start_version_id: number | null;
          completion_version_id: number | null;
          legacy_log_id: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          habit_id: string;
          source: "timed" | "quick" | "legacy";
          status: "running" | "paused" | "completed" | "cancelled";
          recording_mode: "timer" | "quick" | "legacy";
          completed_on?: string | null;
          duration_ms?: number | null;
          estimated_ms?: number | null;
          note?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          start_version_id?: number | null;
          completion_version_id?: number | null;
          legacy_log_id?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          habit_id?: string;
          source?: "timed" | "quick" | "legacy";
          status?: "running" | "paused" | "completed" | "cancelled";
          recording_mode?: "timer" | "quick" | "legacy";
          completed_on?: string | null;
          duration_ms?: number | null;
          estimated_ms?: number | null;
          note?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          start_version_id?: number | null;
          completion_version_id?: number | null;
          legacy_log_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "habit_sessions_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_sessions_habit_id_fkey";
            columns: ["habit_id"];
            referencedRelation: "habits";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_sessions_start_version_id_fkey";
            columns: ["start_version_id"];
            referencedRelation: "habit_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_sessions_completion_version_id_fkey";
            columns: ["completion_version_id"];
            referencedRelation: "habit_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_sessions_legacy_log_id_fkey";
            columns: ["legacy_log_id"];
            referencedRelation: "habit_logs";
            referencedColumns: ["id"];
          }
        ];
      };
      habit_session_segments: {
        Row: {
          id: number;
          session_id: string;
          user_id: string;
          started_at: string;
          ended_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          session_id: string;
          user_id: string;
          started_at?: string;
          ended_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: never;
          session_id?: string;
          user_id?: string;
          started_at?: string;
          ended_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "habit_session_segments_session_id_fkey";
            columns: ["session_id"];
            referencedRelation: "habit_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_session_segments_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
      };
      habit_session_goal_versions: {
        Row: {
          id: number;
          habit_id: string;
          user_id: string;
          effective_week: string;
          weekly_session_target: number | null;
          goal_confirmed: boolean;
          recorded_at: string;
        };
        Insert: {
          id?: never;
          habit_id: string;
          user_id: string;
          effective_week: string;
          weekly_session_target?: number | null;
          goal_confirmed?: boolean;
          recorded_at?: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "habit_session_goal_versions_habit_id_fkey";
            columns: ["habit_id"];
            referencedRelation: "habits";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "habit_session_goal_versions_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      bloom_create_habit: {
        Args: {
          p_request_id: string;
          p_name: string;
          p_description?: string | null;
          p_time?: string | null;
        };
        Returns: Json;
      };
      bloom_update_habit: {
        Args: {
          p_request_id: string;
          p_habit_id: string;
          p_name: string;
          p_description?: string | null;
          p_time?: string | null;
        };
        Returns: Json;
      };
      bloom_archive_habit: {
        Args: {
          p_request_id: string;
          p_habit_id: string;
        };
        Returns: Json;
      };
      bloom_start_session: {
        Args: { p_request_id: string; p_habit_id: string };
        Returns: Json;
      };
      bloom_pause_session: {
        Args: { p_request_id: string; p_session_id: string };
        Returns: Json;
      };
      bloom_resume_session: {
        Args: { p_request_id: string; p_session_id: string };
        Returns: Json;
      };
      bloom_complete_session: {
        Args: { p_request_id: string; p_session_id: string };
        Returns: Json;
      };
      bloom_cancel_session: {
        Args: { p_request_id: string; p_session_id: string };
        Returns: Json;
      };
      bloom_quick_log: {
        Args: {
          p_request_id: string;
          p_habit_id: string;
          p_date: string;
          p_estimated_ms?: number | null;
          p_note?: string | null;
        };
        Returns: Json;
      };
      bloom_set_weekly_goal: {
        Args: {
          p_request_id: string;
          p_habit_id: string;
          p_effective_week: string;
          p_weekly_session_target: number | null;
        };
        Returns: Json;
      };
      lagos_date: {
        Args: { ts?: string };
        Returns: string;
      };
      lagos_week_start: {
        Args: { d: string };
        Returns: string;
      };
      get_active_goal: {
        Args: { p_habit_id: string; p_week: string };
        Returns: {
          id: number;
          weekly_session_target: number | null;
          goal_confirmed: boolean;
          effective_week: string;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
