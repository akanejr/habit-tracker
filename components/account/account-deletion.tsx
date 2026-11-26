"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface AccountDeletionProps {
  userId: string;
  email: string;
}

export function AccountDeletion({ userId, email }: AccountDeletionProps) {
  const router = useRouter();
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleDeleteAccount = async () => {
    if (confirmationText !== "DELETE MY ACCOUNT") {
      setError('Please type "DELETE MY ACCOUNT" to confirm account deletion.');
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      // Call the server-side API route (never expose service role key to client)
      const response = await fetch("/api/account/delete", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirmation: confirmationText }),
      });

      const result = await response.json();

      if (!response.ok) {
        if (result.partialSuccess) {
          // Database deletion succeeded, but Auth deletion failed
          // Recovery mechanism is automatically scheduled
          setError(
            "Your account data has been deleted. Authentication deletion is being retried automatically. You will receive confirmation when complete."
          );
          setSuccess(true);
          return;
        }
        throw new Error(result.error || "Account deletion failed");
      }

      if (!result.success) {
        throw new Error("Account deletion failed");
      }

      // Show success message
      setSuccess(true);

      // Redirect to home page after a short delay
      setTimeout(() => {
        router.push("/");
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred during account deletion");
    } finally {
      setIsDeleting(false);
    }
  };

  if (success) {
    return (
      <section className="p-6 bg-green-50 dark:bg-green-900/20 rounded-lg shadow">
        <h2 className="text-xl font-semibold mb-4 text-green-900 dark:text-green-100">
          Account Deleted Successfully
        </h2>
        <p className="text-green-800 dark:text-green-200">
          Your account and all associated data have been permanently deleted. You will be redirected
          to the home page shortly.
        </p>
      </section>
    );
  }

  return (
    <section className="p-6 bg-white dark:bg-gray-800 rounded-lg shadow border-2 border-red-200 dark:border-red-800">
      <h2 className="text-xl font-semibold mb-4 text-red-900 dark:text-red-100">
        Delete Account
      </h2>
      <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
        <p className="text-sm text-red-800 dark:text-red-200 mb-2">
          <strong>Warning:</strong> This action is permanent and cannot be undone.
        </p>
        <p className="text-sm text-red-700 dark:text-red-300">
          Deleting your account will permanently remove:
        </p>
        <ul className="list-disc list-inside text-sm text-red-700 dark:text-red-300 mt-2 space-y-1">
          <li>Your profile and display name</li>
          <li>All your habits and habit history</li>
          <li>All session data and logs</li>
          <li>All goal versions and progress</li>
        </ul>
      </div>

      {!showConfirmation ? (
        <button
          onClick={() => setShowConfirmation(true)}
          className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
        >
          Delete My Account
        </button>
      ) : (
        <div className="space-y-4">
          <div>
            <label
              htmlFor="confirmation"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
            >
              To confirm deletion, type <strong>DELETE</strong> below:
            </label>
            <input
              id="confirmation"
              type="text"
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              placeholder="Type DELETE MY ACCOUNT to confirm"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-red-500 dark:bg-gray-700 dark:text-gray-100"
              disabled={isDeleting}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleDeleteAccount}
              disabled={isDeleting || confirmationText !== "DELETE"}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDeleting ? "Deleting..." : "Permanently Delete Account"}
            </button>
            <button
              onClick={() => {
                setShowConfirmation(false);
                setConfirmationText("");
                setError(null);
              }}
              disabled={isDeleting}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded hover:bg-gray-300 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
