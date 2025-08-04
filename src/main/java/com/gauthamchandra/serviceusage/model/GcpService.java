package com.gauthamchandra.serviceusage.model;

import java.util.Objects;

public record GcpService(String name, String title, String summary, String documentationUrl) {
    public GcpService {
        Objects.requireNonNull(name, "Service name cannot be null");
        Objects.requireNonNull(title, "Service title cannot be null");
    }

    public static GcpService create(String name, String title) {
        return new GcpService(name, title, null, null);
    }

    public static GcpService create(String name, String title, String summary, String documentationUrl) {
        return new GcpService(name, title, summary, documentationUrl);
    }

    public String getResourceName() {
        return name;
    }
}
