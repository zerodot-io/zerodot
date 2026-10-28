// SPDX-License-Identifier: AGPL-3.0-only

import { getRequestHeaders } from "@tanstack/react-start/server";
import { projectFor, sessionFor } from "@zerodot/server/session.server";

export { isAdmin, projectsFor } from "@zerodot/server/session.server";

export const requireSession = () => sessionFor(getRequestHeaders());

/** Session plus membership for a project slug. Null when signed out or not a member. */
export const requireProject = (slug: string) => projectFor(getRequestHeaders(), slug);
