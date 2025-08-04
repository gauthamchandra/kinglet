package com.gauthamchandra.health;

import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.is;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
class HealthResourceTest {

    @Test
    @DisplayName("[GET] /health - returns 'Emulator running' with 200 status")
    void testHealthEndpoint() {
        given().when().get("/health").then().statusCode(200).body(is("Emulator running"));
    }
}
