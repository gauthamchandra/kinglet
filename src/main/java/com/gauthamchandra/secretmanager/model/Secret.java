package com.gauthamchandra.secretmanager.model;

import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class Secret {

    private final String name;
    private final Map<Integer, SecretVersion> versions;
    private final Map<String, String> labels;
    private final OffsetDateTime createTime;

    public Secret(
            String name, Map<Integer, SecretVersion> versions, Map<String, String> labels, OffsetDateTime createTime) {
        this.name = name;
        this.versions = new ConcurrentHashMap<>(versions);
        this.labels = new ConcurrentHashMap<>(labels != null ? labels : new ConcurrentHashMap<>());
        this.createTime = createTime;
    }

    public static Secret create(String name) {
        return new Secret(name, new ConcurrentHashMap<>(), new ConcurrentHashMap<>(), OffsetDateTime.now());
    }

    public static Secret create(String name, Map<String, String> labels) {
        return new Secret(name, new ConcurrentHashMap<>(), labels, OffsetDateTime.now());
    }

    public String name() {
        return name;
    }

    public Map<Integer, SecretVersion> versions() {
        return Collections.unmodifiableMap(versions);
    }

    public Map<String, String> labels() {
        return Collections.unmodifiableMap(labels);
    }

    public OffsetDateTime createTime() {
        return createTime;
    }

    public String getResourceName(String project) {
        return String.format("projects/%s/secrets/%s", project, name);
    }

    public int getNextVersionNumber() {
        return versions.size() + 1;
    }

    public SecretVersion addVersion(String data) {
        int versionNumber = getNextVersionNumber();
        SecretVersion version = SecretVersion.create(versionNumber, data);
        versions.put(versionNumber, version);
        return version;
    }

    public SecretVersion getVersion(int versionNumber) {
        return versions.get(versionNumber);
    }

    public SecretVersion getVersion(String versionId) {
        if ("latest".equals(versionId)) {
            return getLatestVersion();
        }
        try {
            int versionNumber = Integer.parseInt(versionId);
            return getVersion(versionNumber);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public SecretVersion getLatestVersion() {
        return versions.values().stream()
                .filter(v -> !v.isDestroyed())
                .max((v1, v2) -> Integer.compare(v1.versionNumber(), v2.versionNumber()))
                .orElse(null);
    }

    public SecretVersion updateVersionState(int versionNumber, SecretVersion.VersionState newState) {
        SecretVersion currentVersion = versions.get(versionNumber);
        if (currentVersion == null) {
            return null;
        }
        SecretVersion updatedVersion = currentVersion.withState(newState);
        versions.put(versionNumber, updatedVersion);
        return updatedVersion;
    }

    public Secret withLabels(Map<String, String> newLabels) {
        return new Secret(name, versions, newLabels, createTime);
    }
}
