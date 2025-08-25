#!/usr/bin/env node
/**
 * Build script for Monifactory
 *
 * This script uses Juke Build, read the docs here:
 * https://github.com/stylemistake/juke-build
 */

import fs from "fs";
import path, { resolve } from "path";
import Juke from "juke-build";
import { DownloadCF, GetModInfo } from "./lib/curseforge.ts";
import { CodegenAllTarget } from "./codegen/target-all.ts";
import { z } from "zod";
import { progressNumber } from "./lib/log.ts"

Juke.chdir("..", import.meta.url);
Juke.setup({ file: import.meta.url }).then(process.exit); // exit on windows

const includeList = [
    "config",
    "defaultconfigs",
    "config-overrides",
    "kubejs",
]

/** All mods must be lower-case */
const clientMods = [
    "oculus",
    "zume",
    "watermedia",
    "embeddium",
    "embeddiumplus",
    "citresewn",
    "legendarytooltips",
    "fancymenu",
    "drippyloadingscreen",
    "badoptimizations"
]

/**
 * @param {fs.PathLike} ourDir
 * @param {fs.PathLike} newDir
 */
const symlinkSync = (ourDir, newDir) => {
    if (process.platform === "win32") {
        if (!fs.lstatSync(ourDir).isDirectory()) {
            fs.copyFileSync(ourDir, newDir);
            return;
        }
        fs.symlinkSync(ourDir, newDir, "junction")
        return;
    }
    fs.symlinkSync(ourDir, newDir)
}

/**
 * @param {fs.PathLike} ourDir
 * @param {fs.PathLike} newDir
 * @param {(file: string) => boolean} filter
 */
const cpSyncFiltered = (ourDir, newDir, filter) => {
    for (const file of fs.readdirSync(ourDir, { recursive:false, encoding: "utf8" })) {
        if (!filter(file)) continue;
        fs.copyFileSync(path.join(ourDir, file), path.join(newDir, file))
    }
}


async function zipBuild(group: string) {
    try {
        if (process.platform === "win32") {
            await Juke.exec("powershell", [
                "Compress-Archive",
                `-Path "${resolve(`dist\\${group}\\*`)}"`,
                `-DestinationPath "${resolve(`dist\\${group}.zip`)}"`,
            ]);
            return;
        }
        let hasZipCmd: boolean = false;
        try {
            await Juke.exec("zip", ["--help"], {silent: true});
            hasZipCmd = true;
        } catch {
            Juke.logger.error("Zip command not found, please install zip")
            process.exit(1);
        }

        if (hasZipCmd) {
            await Juke.exec("zip", [
                "-qyr",
                `../${group}.zip`,  // file out
                ".", // include everything
            ], {
                cwd: `dist/${group}`,
            })
            return;
        }
    } catch (error) {
        Juke.logger.error(error);
        throw new Juke.ExitCode(1);
    }
}

async function applyDefaultMode(configPath: string) {
    if (!fs.existsSync(`${configPath}/config/packmode.json`)) {
        if (process.platform === "win32") {
            await Juke.exec("cmd.exe", ["/c", resolve("pack-mode-switcher.bat"), "-r", "-s", "n"], {
                cwd: configPath,
            });
            return;
        }
        await Juke.exec("chmod", ["+x", "pack-mode-switcher.sh"]);
        await Juke.exec("pack-mode-switcher.sh", ["-r", "-s", "n"], {
            cwd: configPath,
        });
    }
}

async function packBuild(group: string) {
    fs.copyFileSync("manifest.json", `dist/${group}/manifest.json`);
    fs.copyFileSync("dist/modlist.html", `dist/${group}/modlist.html`);
    fs.copyFileSync("LICENSE.md", `dist/${group}/LICENSE.md`);

    await applyDefaultMode(`dist/${group}${group === "server" ? "" : "/overrides"}`);
    await zipBuild(group);
}

export const BuildModlistTarget = new Juke.Target({
    inputs: ["manifest.json"],
    outputs: ["dist/modlist.html"],
    executes: async () => {
        fs.mkdirSync("dist", { recursive: true })
        const {files} = z.object({
            files: z.object({
                projectID: z.number()
            }).array()
        }).parse(
            JSON.parse(fs.readFileSync("manifest.json", "utf-8"))
        );
        const total = progressNumber(files.length)
        let html = "<ul>\n"
        for (const [i, {projectID}] of files.entries()) {
            const modInfo = await GetModInfo(projectID);
            Juke.logger.info(`Downloaded: (${total(i)}) Mod info "${modInfo.name}"`)
            html += `<li><a href=${modInfo.links.websiteUrl}>${modInfo.name} (by ${modInfo.authors[0].name})</a></li>\n`;
        }
        html += "</ul>"
        fs.writeFileSync("dist/modlist.html", html);
    }
})

export const DownloadModsTarget = new Juke.Target({
    inputs: ["manifest.json"],
    outputs: () => [], // always run, we have internal logic to check mods now
    executes: async () => {
        const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf-8"));

        fs.mkdirSync("dist/modcache", { recursive: true })

        // get old jsondata files cache
        let dataKeys = {};
        const mIdToDownload = [];
        if (fs.existsSync("dist/cache.json")) {
            Juke.logger.info("Modmeta cache hit")
            // diff new & old data
            const oldData = JSON.parse(fs.readFileSync("dist/cache.json", "utf-8"));
            const newData = {}
            for (const key in manifest.files) {
                const data = manifest.files[key];
                const { projectID, fileID, required } = data;
                newData[`${projectID}`] = { fileID, required }
            }

            const oldDataKeys = Object.keys(oldData);
            const newDataKeys = Object.keys(newData);

            // filter returns changed mods, lets see now who owns them
            for (const pid of oldDataKeys.filter(pid => !newDataKeys.includes(pid))
                .concat(newDataKeys.filter(x => !oldDataKeys.includes(x)))) {
                const fromOldData = oldData[`${pid}`];
                if (fromOldData) {
                    // from old, which means this is removed
                    Juke.rm(`dist/modcache/${fromOldData["file"]}`)
                    Juke.logger.info(`Mod was removed from modpack: ${pid}`)
                    delete oldData[`${pid}`]
                    continue;
                }
                if (newData[`${pid}`] && !mIdToDownload.includes(`${pid}`)) { // new mod added
                    mIdToDownload.push(`${pid}`);
                    Juke.logger.info(`Mod was added from modpack: ${pid}`)
                    oldData[`${pid}`] = {...newData[`${pid}`]} // copy
                }
            }

            // now filter changed *fileids*, could prolly b optimized and use 1 loop instead of 2
            for (const pid of oldDataKeys.filter(pid => (
                newData[pid] && oldData[pid]["fileID"] !== newData[pid]["fileID"]))) {
                const fromOldData = oldData[`${pid}`];
                // from old, which means this is updated
                if (fromOldData) {
                    Juke.rm(`dist/modcache/${fromOldData["file"]}`)
                    Juke.logger.info(`Mod was updated from modpack: ${pid}`)
                    if (!mIdToDownload.includes(`${pid}`)) mIdToDownload.push(`${pid}`);
                    oldData[`${pid}`] = {
                        file: undefined,
                        fileID: newData[pid]["fileID"],
                        required: newData[pid]["required"]
                    }
                }
            }
            dataKeys = oldData;
        } else {
            Juke.logger.info("Modmeta remapping")
            for (const key in manifest.files) {
                const data = manifest.files[key];
                const { projectID, fileID, required } = data;
                dataKeys[`${projectID}`] = { fileID, required }
                mIdToDownload.push(`${projectID}`);
            }
        }

        for (const modID of mIdToDownload) {
            const file = dataKeys[modID];
            const res = await DownloadCF({
                modID,
                modFileID: file.fileID
            }, "dist/modcache/");
            dataKeys[modID]["file"] = res.fileName;
        }
        fs.writeFileSync("dist/cache.json", JSON.stringify(dataKeys))
    }
});

export * from "./codegen/target-all.ts";

export const BuildClientTarget = new Juke.Target({
    dependsOn: [CodegenAllTarget, BuildModlistTarget],
    inputs: [
        ...includeList,
        "dist/modlist.html"
    ],
    outputs: () => ([
        "dist/client/",
        "dist/client.zip",
        ...includeList.map(v => `dist/client/overrides/${v}`),
    ]),
    executes: async () => {
        fs.mkdirSync("dist/client/overrides", { recursive: true })
        for (const folders of includeList) {
            fs.cpSync(folders, `dist/client/overrides/${folders}`, { recursive: true })
        }

        await packBuild("client");
    }
})

export const BuildServerTarget = new Juke.Target({
    dependsOn: [CodegenAllTarget, BuildModlistTarget, DownloadModsTarget],
    inputs: [
        ...includeList,
        "dist/modlist.html"
    ],
    outputs: () => ([
        "dist/server/",
        "dist/server.zip",
        ...includeList.map(v => `dist/server/${v}`),
        "dist/server/mods"
    ]),
    executes: async () => {
        fs.mkdirSync("dist/server", { recursive: true })
        for (const folders of includeList) {
            fs.cpSync(folders, `dist/server/${folders}`, { recursive: true })
        }

        fs.mkdirSync("dist/server/mods")
        cpSyncFiltered("dist/modcache/", "dist/server/mods", file => {
            const fillet = file.toLowerCase();
            return (
                fillet.includes(".jar")
                && !clientMods.find(modName => fillet.includes(modName))
            )
        })

        await packBuild("server");
    }
})

export const BuildDevTarget = new Juke.Target({
    dependsOn: [BuildModlistTarget, DownloadModsTarget],
    inputs: [
        // weird bug with symlinked config and mods folder
        ...includeList,
        "dist/modlist.html"
    ],
    outputs: () => ([
        "dist/dev/",
        "dist/.devmods/",
        "dist/dev.zip",
        ...includeList.map(v => `dist/dev/overrides/${v}`),
        "dist/dev/overrides/mods",
    ]),
    executes: async () => {
        Juke.rm("dist/.devmods", { recursive: true })

        if (fs.existsSync("dist/dev")) {
            Juke.logger.info("Only updating mods as dist/dev exists");

            fs.mkdirSync("dist/dev/overrides", { recursive: true });
            fs.cpSync("dist/modcache", "dist/.devmods", { recursive: true });
            fs.cpSync("mods", "dist/.devmods", { recursive: true });
            return;
        }

        fs.mkdirSync("dist/dev/overrides", { recursive: true });
        fs.mkdirSync("dist/.devmods", { recursive: true });
        for (const folders of includeList.filter(v => !(v === "mods"))) {
            symlinkSync(resolve(folders), resolve(`dist/dev/overrides/${folders}`));
        }

        // "merge" both mod folders
        fs.cpSync("dist/modcache", "dist/.devmods", { recursive: true });
        fs.cpSync("mods", "dist/.devmods", { recursive: true, force: true });
        symlinkSync(resolve("dist/.devmods"), resolve("dist/dev/overrides/mods"));
        // fs.cpSync('dist/.devmods', 'dist/dev/mods', { recursive: true });
        fs.cpSync("config", "dist/dev/overrides/config", { recursive: true });

        await packBuild("dev")
    }
})

export const BuildAllTarget = new Juke.Target({
    dependsOn: [BuildServerTarget, BuildClientTarget]
})

export const CleanCacheTarget = new Juke.Target({
    executes: async () => {
        Juke.rm("dist/modcache", { recursive: true });
        Juke.rm("dist/modlist.html");
    },
})

export const CleanBuildTarget = new Juke.Target({
    executes: async () => {
        Juke.rm("dist/client", { recursive: true });
        Juke.rm("dist/dev", { recursive: true });
        Juke.rm("dist/server", { recursive: true });
        Juke.rm("dist/.devmods", { recursive: true });
        Juke.rm("dist/*.zip");
    },
})

export const CleanAllTarget = new Juke.Target({
    dependsOn: [CleanCacheTarget, CleanBuildTarget],
});

export default BuildDevTarget;
