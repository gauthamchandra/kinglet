package com.gauthamchandra.health;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/")
public class HealthResource {

    @GET
    @Path("health")
    @Produces(MediaType.TEXT_PLAIN)
    public Response health() {
        return Response.ok("Emulator running").build();
    }
}
