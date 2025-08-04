package com.gauthamchandra.serviceusage.resource;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

import com.gauthamchandra.serviceusage.model.generated.BatchDisableServicesRequest;
import com.gauthamchandra.serviceusage.model.generated.BatchEnableServicesRequest;
import io.quarkus.test.junit.QuarkusTest;
import io.restassured.http.ContentType;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
class ServiceUsageResourceTest {

    @Test
    @DisplayName("[POST] /v1/projects/{project}/services/{serviceName}:enable - enables service successfully")
    void testEnableServiceEnablesServiceSuccessfully() {
        String project = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:enable", project, serviceName)
                .then()
                .statusCode(200)
                .body("name", startsWith("operations/"))
                .body("done", is(true))
                .body("metadata.type", is("ENABLE_SERVICE"))
                .body("metadata.projectId", is(project));
    }

    @Test
    @DisplayName(
            "[POST] /v1/projects/{project}/services/{serviceName}:enable - returns bad request for invalid service")
    void testEnableServiceReturnsBadRequestForInvalidService() {
        String project = "test-project";
        String serviceName = "invalid.googleapis.com";

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:enable", project, serviceName)
                .then()
                .statusCode(400);
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/services/{serviceName}:disable - disables service successfully")
    void testDisableServiceDisablesServiceSuccessfully() {
        String project = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:disable", project, serviceName)
                .then()
                .statusCode(200)
                .body("name", startsWith("operations/"))
                .body("done", is(true))
                .body("metadata.type", is("DISABLE_SERVICE"))
                .body("metadata.projectId", is(project));
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/services:batchEnable - enables multiple services")
    void testBatchEnableServicesEnablesMultipleServices() {
        String project = "test-project";
        BatchEnableServicesRequest request = new BatchEnableServicesRequest()
                .serviceIds(List.of("secretmanager.googleapis.com", "serviceusage.googleapis.com"));

        given().contentType(ContentType.JSON)
                .body(request)
                .when()
                .post("/v1/projects/{project}/services:batchEnable", project)
                .then()
                .statusCode(200)
                .body("name", startsWith("operations/"))
                .body("done", is(true))
                .body("metadata.type", is("BATCH_ENABLE_SERVICES"));
    }

    @Test
    @DisplayName("[POST] /v1/projects/{project}/services:batchDisable - disables multiple services")
    void testBatchDisableServicesDisablesMultipleServices() {
        String project = "test-project";
        BatchDisableServicesRequest request = new BatchDisableServicesRequest()
                .serviceIds(List.of("secretmanager.googleapis.com", "serviceusage.googleapis.com"));

        given().contentType(ContentType.JSON)
                .body(request)
                .when()
                .post("/v1/projects/{project}/services:batchDisable", project)
                .then()
                .statusCode(200)
                .body("name", startsWith("operations/"))
                .body("done", is(true))
                .body("metadata.type", is("BATCH_DISABLE_SERVICES"));
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/services - lists all services")
    void testListServicesListsAllServices() {
        String project = "test-project";

        given().when()
                .get("/v1/projects/{project}/services", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(greaterThanOrEqualTo(4)))
                .body("services[0].name", startsWith("projects/" + project + "/services/"))
                .body("services[0].state", is("DISABLED"))
                .body("services[0].config.name", notNullValue())
                .body("services[0].config.title", notNullValue());
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/services - filters by enabled state")
    void testListServicesFiltersByEnabledState() {
        String project = "test-project-enabled";
        String serviceName = "secretmanager.googleapis.com";

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:enable", project, serviceName);

        given().when()
                .get("/v1/projects/{project}/services?filter=state:ENABLED", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(1))
                .body("services[0].name", is("projects/" + project + "/services/" + serviceName))
                .body("services[0].state", is("ENABLED"));
    }

    @Test
    @DisplayName("[GET] /v1/projects/{project}/services - filters by disabled state")
    void testListServicesFiltersByDisabledState() {
        String project = "test-project-disabled";
        String serviceName = "secretmanager.googleapis.com";

        given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:enable", project, serviceName);

        given().when()
                .get("/v1/projects/{project}/services?filter=state:DISABLED", project)
                .then()
                .statusCode(200)
                .body("services", hasSize(greaterThanOrEqualTo(3)))
                .body("services.findAll { it.name.contains('" + serviceName + "') }", hasSize(0));
    }

    @Test
    @DisplayName("[GET] /v1/operations/{operationName} - returns operation status")
    void testGetOperationReturnsOperationStatus() {
        String project = "test-project-operation";
        String serviceName = "secretmanager.googleapis.com";

        String operationName = given().contentType(ContentType.JSON)
                .body("{}")
                .when()
                .post("/v1/projects/{project}/services/{serviceName}:enable", project, serviceName)
                .then()
                .statusCode(200)
                .extract()
                .path("name");

        given().when()
                .get("/v1/{operationName}", operationName)
                .then()
                .statusCode(200)
                .body("name", is(operationName))
                .body("done", is(true))
                .body("metadata.type", is("ENABLE_SERVICE"));
    }

    @Test
    @DisplayName("[GET] /v1/operations/{operationName} - returns not found for invalid operation")
    void testGetOperationReturnsNotFoundForInvalidOperation() {
        String operationName = "operations/invalid-operation";

        given().when().get("/v1/{operationName}", operationName).then().statusCode(404);
    }
}
