package com.gauthamchandra.serviceusage.integration;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
@DisplayName("Service Enablement Workflow Integration Tests")
class ServiceEnablementWorkflowTest {

    @Test
    @DisplayName("Complete service enablement workflow - list, enable, use, disable")
    void testCompleteServiceEnablementWorkflow() {
        String project = "workflow-test-project";
        String serviceName = "secretmanager.googleapis.com";

        given().when()
                .get("/v1/projects/{project}/services?filter=state:DISABLED", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(greaterThanOrEqualTo(4)));

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:enable", project, serviceName)
                .then()
                .statusCode(200)
                .body("done", is(true))
                .body("metadata.type", is("ENABLE_SERVICE"));

        given().when()
                .get("/v1/projects/{project}/services?filter=state:ENABLED", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(1))
                .body("services[0].name", containsString(serviceName))
                .body("services[0].state", is("ENABLED"));

        given().contentType(ContentType.JSON)
                .body("{\"secretId\": \"test-secret\"}")
                .when()
                .post("/v1/projects/{project}/secrets", project)
                .then()
                .statusCode(200)
                .body("name", containsString("test-secret"));

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:disable", project, serviceName)
                .then()
                .statusCode(200)
                .body("done", is(true))
                .body("metadata.type", is("DISABLE_SERVICE"));

        given().contentType(ContentType.JSON)
                .body("{\"secretId\": \"another-secret\"}")
                .when()
                .post("/v1/projects/{project}/secrets", project)
                .then()
                .statusCode(400);
    }

    @Test
    @DisplayName("Batch service operations workflow")
    void testBatchServiceOperationsWorkflow() {
        String project = "batch-test-project";

        given().contentType(ContentType.JSON)
                .body("{\"serviceIds\": [\"secretmanager.googleapis.com\", \"serviceusage.googleapis.com\"]}")
                .when()
                .post("/v1/projects/{project}/services:batchEnable", project)
                .then()
                .statusCode(200)
                .body("done", is(true))
                .body("metadata.type", is("BATCH_ENABLE_SERVICES"));

        given().when()
                .get("/v1/projects/{project}/services?filter=state:ENABLED", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(2));

        given().contentType(ContentType.JSON)
                .body("{\"serviceIds\": [\"secretmanager.googleapis.com\", \"serviceusage.googleapis.com\"]}")
                .when()
                .post("/v1/projects/{project}/services:batchDisable", project)
                .then()
                .statusCode(200)
                .body("done", is(true))
                .body("metadata.type", is("BATCH_DISABLE_SERVICES"));

        given().when()
                .get("/v1/projects/{project}/services?filter=state:ENABLED", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(0));
    }
}
