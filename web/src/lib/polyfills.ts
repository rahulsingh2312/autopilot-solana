/**
 * Safari has no explicit-resource-management yet, and `@solana/kit` v7 uses
 * `DisposableStack` at module scope. Without this the entire bundle throws
 * `Can't find variable: DisposableStack` before React mounts, so every iOS
 * visitor sees a blank "This page couldn't load" screen.
 *
 * Import this FIRST, above any Kit import, so it evaluates before Kit does.
 */
import "disposablestack/auto";
