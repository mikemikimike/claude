import { error, json, withAuth } from "@/lib/http";
import { EmailConflictError, resolveSyncRole, upsertUser } from "@/lib/users";
import { ROLES, resolveRole, type Role } from "@/lib/roles";

type SyncBody = {
  email?: string;
  name?: string;
};

export async function POST(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    let body: SyncBody;
    try {
      body = (await req.json()) as SyncBody;
    } catch {
      return error("invalid request body", 400);
    }
    const email = typeof body.email === "string" ? body.email : "";
    const name = typeof body.name === "string" ? body.name : "";

    // A claim carrying ONLY unrecognized roles is a misconfigured/typo'd Auth0
    // role. Reject it with a clear 400 up front rather than letting it fall
    // through to the DB/invite fallbacks and silently succeed with a stale role
    // (#308). Checked here, before resolveSyncRole, because only the route can
    // tell "the claim was present but junk" apart from "there was no claim".
    if (claims.roles.length > 0 && !resolveRole(claims.roles)) {
      return error(
        `unrecognized role claim (${JSON.stringify(
          claims.roles
        )}); expected one of: ${ROLES.join(", ")}`,
        400
      );
    }

    // Role precedence lives in lib/roles.ts#decideRole — one place. Do NOT
    // reintroduce a role guard here or in upsertUser. In particular the JWT
    // claim no longer wins unconditionally: the tenant hands every new signup a
    // default `agent` role, and that used to overwrite the `buyer`/`seller` an
    // invite claim had just written, dropping invited clients into the agent
    // app. No role anywhere = 403.
    const role: Role | null = await resolveSyncRole({
      auth0Id: claims.sub,
      claimRoles: claims.roles,
      email,
    });
    if (!role) {
      return error(
        "no role assigned — request an invite from your administrator",
        403
      );
    }

    let user;
    try {
      user = await upsertUser({
        auth0Id: claims.sub,
        email,
        name,
        role,
      });
    } catch (err) {
      // A second Auth0 identity reusing another user's email surfaces as a
      // typed collision — return a readable 409 instead of a generic 500 so
      // the client can recover (log in with the original account) (#277).
      if (err instanceof EmailConflictError) {
        return error(err.message, err.status);
      }
      throw err;
    }
    return json(user);
  })) as Response;
}
