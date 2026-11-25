import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function DELETE(request: Request) {
  try {
    // Authenticate user
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    // Parse request body
    const { confirmation } = await request.json();

    // Validate confirmation
    if (confirmation !== '
      return NextResponse.json(
        { error: "Invalid confirmation text" },
        { status: 400 }
      );
    }

    // Step 1: Delete application data via RPC
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

    // Step 2: Delete Supabase Auth user via Admin API
    // This requires the service role key, which should NEVER be exposed to the client
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

    if (!serviceRoleKey || !supabaseUrl) {
      console.error("Missing Supabase Admin API credentials");
      // Database deletion succeeded, but Auth deletion failed
      // This is a partial failure scenario
      return NextResponse.json(
        { 
          error: "Account data deleted, but authentication account deletion failed",
          partialSuccess: true,
          message: "Please contact support to complete account deletion"
        },
        { status: 500 }
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
        // Database deletion succeeded, but Auth deletion failed
        return NextResponse.json(
          { 
            error: "Account data deleted, but authentication account deletion failed",
            partialSuccess: true,
            message: "Please contact support to complete account deletion"
          },
          { status: 500 }
        );
      }
    } catch (adminException) {
      console.error("Auth deletion exception:", adminException);
      // Database deletion succeeded, but Auth deletion failed
      return NextResponse.json(
        { 
          error: "Account data deleted, but authentication account deletion failed",
          partialSuccess: true,
          message: "Please contact support to complete account deletion"
        },
        { status: 500 }
      );
    }

    // Step 3: Sign out the user
    await supabase.auth.signOut();

    // Success
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
