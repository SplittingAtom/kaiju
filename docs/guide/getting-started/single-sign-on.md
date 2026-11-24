---
title: Signing in with your organization
summary: How to sign in with your organization's account (single sign-on), link it to an existing Kaiju account, unlink it, and why accounts made this way have no Kaiju password.
section: Getting started
order: 3
audience: member
---

If your site uses single sign-on, the sign-in page shows a **Sign in with _your organization_**
button (for example "Sign in with Contoso") below the email and password, after the **or** line,
next to **Sign in with a passkey**. It takes you
to your organization's sign-in page and back to Kaiju, signed in. Your organization decides who may
use Kaiju and in which team, through the roles or groups it gives you.

If your site **requires single sign-on**, the sign-in page shows only those buttons ("This site
requires single sign-on"): there is no password, passkey or **Forgot your password?**, and an
invitation link asks you to sign in with your organization instead of choosing a password. If you
were signed in with a password when your administrator turned it on, Kaiju signs you out; sign in
again with your organization's button.

## Your first sign-in

If your organization gave you access and you have no Kaiju account yet, the first sign-in creates
one and puts you in the teams your access names. There is no invitation and no password to
choose.

If the page says your organization's sign-in **can't be used for this site yet**, either your
organization has not given you access to Kaiju (ask your administrator), or you already have a Kaiju
account with that address (link it, below). Kaiju shows the same message in both cases, so the page
never reveals who has an account.

## Linking an account you already have

Kaiju never joins your organization's sign-in to an existing account just because the address
matches. To link them:

1. Press **Sign in with _your organization_** and sign in there. Kaiju comes back with "can't be
   used for this site yet".
2. Within 10 minutes, sign in on the same page with your Kaiju **password** (and authenticator
   code, if you use one) or your **passkey**.
3. Kaiju opens **Link your organization sign-in**, naming the organization and the address. Press
   **Link _organization_** if you just signed in there yourself, or **Don't link**.

From then on both work: your organization's button and your password or passkey. An administrator
can also prepare the link for you; then your next sign-in with your organization links on its own.
While the site requires single sign-on, step 2 is not possible (password and passkey sign-in are
off): ask your administrator to prepare the link.

## Sign-in methods

**Profile → Sign-in methods** lists the organization sign-ins linked to your account, how each was
linked and when you last used it. **Unlink** stops that sign-in and ends the sessions you started
with it; your password and passkeys stay. You can't unlink your only way to sign in.

## No password for accounts your organization made

An account created by your organization's sign-in (or provisioned by your organization) has no
Kaiju password, passkey or authenticator app, and can't add one: **Forgot your password?** sends
nothing for it. That way, when your organization disables your account, nothing in Kaiju outlives
it. Sign in with the organization's button. Accounts that existed before and were linked keep
their password and passkeys.

## Two-factor sign-in

If your site requires two-factor authentication, Kaiju does not ask for an authenticator code after
an organization sign-in: your organization's own multi-factor authentication counts instead. If
your organization's sign-in did not include it, Kaiju refuses the sign-in; ask your administrator.

## Signing out and being signed out

**Sign out** in the profile menu ends your Kaiju session only, not your organization's sign-in.
Kaiju signs you out by itself when your organization deactivates your account, when an
administrator turns that sign-in off or unlinks it, or when the site's maximum session length for
organization sign-ins has passed. Sign in again; if you can't, ask your administrator.

See [Troubleshooting](../reference/troubleshooting.md#single-sign-on) for each message on the
sign-in page.
