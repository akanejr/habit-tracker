import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const CONFIRMATION_PHRASE = "DELETE MY ACCOUNT";

export async function DELETE(request: Request) {
  try {
    // Step 1: Authenticate user
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // Step 2: Parse and validate confirmation
    const { confirmation } = await request.json();

    if (confirmation !== CONFIRMATION_PHRASE) {
      return NextResponse.json(
        { error: "Invalid confirmation text" },
        { status: 400 }
      );
    }

    // Step 3: Delete application data via RPC
    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      "delete_user_account",
      { p_confirmation_text: confirmation }
    );

    if (rpcError) {
      console.error("Database deletion failed:", rpcError);
      return NextResponse.json(
        { error: "Failed to delete account data", details: rpcError.message },
        { status: 500 }
      );
    }

    if (!rpcResult?.success) {
      return NextResponse.json(
        { error: "Account deletion failed" },
        { status: 500 }
      );
    }

    // Step 4: Delete Supabase Auth user via Admin API
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

    if (!serviceRoleKey || !supabaseUrl) {
      console.error("Missing Supabase Admin API credentials");
      // Record incomplete deletion for recovery
      await supabase.rpc("record_incomplete_deletion", {
        p_user_id: user.id,
        p_user_email: user.email || "unknown",
        p_error: "Missing Supabase Admin API credentials"
      });
      
      return NextResponse.json(
        { 
          error: "Account data deleted, but authentication deletion failed. Recovery in progress.",
          partialSuccess: true,
          recoveryScheduled: true
        },
        { status: 207 }
      );
    }

    try {
      const adminClient = createServiceClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });

      const { error: adminError } = await adminClient.auth.admin.deleteUser(user.id);

      if (adminError) {
        console.error("Auth deletion failed:", adminError);
        
        // Record incomplete deletion for recovery
        await supabase.rpc("record_incomplete_deletion", {
          p_user_id: user.id,
          p_user_email: user.email || "unknown",
          p_error: adminError.message
        });
        
        return NextResponse.json(
          { 
            error: "Account data deleted, but authentication deletion failed. Recovery in progress.",
            partialSuccess: true,
            recoveryScheduled: true
          },
          { status: 207 }
        );
      }
    } catch (adminException) {
      console.error("Auth deletion exception:", adminException);
      
      // Record incomplete deletion for recovery
      await supabase.rpc("record_incomplete_deletion", {
        p_user_id: user.id,
        p_user_email: user.email || "unknown",
        p_error: adminException instanceof Error ? adminException.message : "Unknown error"
      });
      
      return NextResponse.json(
        { 
          error: "Account data deleted, but authentication deletion failed. Recovery in progress.",
          partialSuccess: true,
          recoveryScheduled: true
        },
        { status: 207 }
      );
    }

    // Step 5: Sign out the user
    await supabase.auth.signOut();

    // Step 6: Return success
    return NextResponse.json({
      success: true,
      message: "Account deleted successfully",
      deleted: rpcResult,
    });
  } catch (error) {
    console.error("Account deletion error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Recovery endpoint - only accessible with service role
export async function POST(request: Request) {
  try {
    // Verify service role authentication
    const authHeader = request.headers.get("authorization");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!authHeader || !serviceRoleKey || authHeader !== `Bearer ${serviceRoleKey}`) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { error: "Missing Supabase credentials" },
        { status: 500 }
      );
    }

    const adminClient = createServiceClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Get pending deletions
    const { data: pendingResult, error: pendingError } = await adminClient.rpc(
      "retry_incomplete_deletions"
    );

    if (pendingError) {
      return NextResponse.json(
        { error: "Failed to fetch pending deletions", details: pendingError.message },
        { status: 500 }
      );
    }

    const pending = pendingResult?.pending_deletions || [];
    const results = [];

    // Process each pending deletion
    for (const deletion of pending) {
      try {
        // Increment attempt counter
        await adminClient.rpc("increment_deletion_attempt", {
          p_deletion_id: deletion.id
        });

        // Attempt Auth deletion
        const { error: deleteError } = await adminClient.auth.admin.deleteUser(deletion.user_id);

        if (deleteError) {
          results.push({
            id: deletion.id,
            user_id: deletion.user_id,
            success: false,
            error: deleteError.message
          });
        } else {
          // Mark as resolved
          await adminClient.rpc("mark_deletion_resolved", {
            p_deletion_id: deletion.id
          });

          results.push({
            id: deletion.id,
            user_id: deletion.user_id,
            success: true
          });
        }
      } catch (err) {
        results.push({
          id: deletion.id,
          user_id: deletion.user_id,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error"
        });
      }
    }

    return NextResponse.json({
      processed: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (error) {
    console.error("Recovery error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
