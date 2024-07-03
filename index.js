const express = require("express");
var dotenv = require("dotenv");
dotenv.config();
var multer = require("multer");
const moment = require("moment-timezone");
const bodyParser = require("body-parser");
var AWS = require("aws-sdk");
AWS.config.region = process.env.region;
const port = process.env.port;
const cors = require("cors");
const upload = multer({ dest: "uploads/" });
var fs = require("fs-extra");
var path = require("path");
const klawSync = require("klaw-sync");
const { RSA_NO_PADDING } = require("constants");
const mongoose = require("mongoose");
const { default: axios } = require("axios");
const { log } = require("console");
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
mongoose
  .connect(process.env.DATABASE_URL)
  .then(() => {
    console.log("DB CONNECTED SUCCEFULLY");
  })
  .catch((error) => {
    console.log(error);
  });
app.get("/", function (req, res) {
  res.send("Hello World");
});
const attendanceSchema = new mongoose.Schema(
  {
    userId: String,
    fullName: String,
    database: String,
    outtime: Array,
    intime: Array,
    lateTime: String,
    branch: String,
    currentDate: String,
    shift: Object,
    late: String,
    early: String,
  },
  { timestamps: true }
);

const AttendanceAws = mongoose.model("employeeAttendance", attendanceSchema);

const dataAttendanceSchema = new mongoose.Schema(
  {
    image: String,
    currentTime: String,
    shift: Object,
    fullName: String,
    currentDate: String,
    database: String,
    branch: String,
  },
  { timestamps: true }
);

const DataAttendance = mongoose.model("dataAttendance", dataAttendanceSchema);

var rekognition = new AWS.Rekognition({ region: process.env.region });
function convertTo24Hour(time) {
  const [timePart, modifier] = time.split(" ");
  let [hours, minutes] = timePart.split(":");
  if (hours === "12") {
    hours = "00";
  }
  if (modifier === "PM") {
    hours = parseInt(hours, 10) + 12;
  }
  return `${hours}:${minutes}`;
}

const inTimeStore = {};
app.post("/api/recognize", upload.single("image"), async (req, res) => {
  if (req.file) {
    req.body.image = req.file.filename;
  }
  const dataLocal = new DataAttendance({
    image: req.body.image,
    currentTime: req.body.currentTime,
    shift: req.body.shift,
    currentDate: req.body.currentDate,
    database: req.body.database,
    branch: req.body.branch,
  });
  await dataLocal.save();

  const base64Data = req.body.image?.replace("data:image/jpeg;base64,", "");
  let userId;
  let fullName;
  const imageBuffer = Buffer?.from(base64Data, "base64");
  if (!isValidImageFormat(imageBuffer)) {
    return res.status(400).json({ error: "Invalid image format" });
  }

  try {
    const s3Params = {
      Bucket: process.env.Bucket,
    };
    const s3Objects = await s3.listObjectsV2(s3Params).promise();
    for (const obj of s3Objects.Contents) {
      const s3Image = await s3
        .getObject({ Bucket: process.env.Bucket, Key: obj.Key })
        .promise();
      if (obj.Key?.includes("-") && obj.Key?.includes(".")) {
        userId = obj.Key.split("-")[1].split(".")[0];
        fullName = obj.Key.split("-")[0];
      } else {
        fullName = obj.Key.split(".")[0];
        userId = obj.Key.split(".")[0];
      }
      const s3ImageBuffer = s3Image.Body;
      const compareParams = {
        SourceImage: { Bytes: imageBuffer },
        TargetImage: { Bytes: s3ImageBuffer },
        SimilarityThreshold: 80,
      };

      const compareResult = await rekognition
        .compareFaces(compareParams)
        .promise();
      console.log(compareResult);
      if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0) {
        // // const match = compareResult.FaceMatches[0];
        // const currentDate = req.body.currentDate;
        // const shift = JSON?.parse(req.body.shift);
        // // const shift = req.body.shift;

        // const currentTime = req.body.currentTime;
        // console.log("currentTime", currentTime);
        // const timeParts = currentTime?.split(" ");
        // const time = timeParts[0];
        // const timeComponents = time?.split(":");
        // const hours = timeComponents[0];
        // const minutes = timeComponents[1];
        // const formattedTime = `${hours}:${minutes}`;
        // const shiftStartTime = shift?.fromTime;
        // const lateByTime = shift?.lateByTime;
        // const shiftEndTime = shift?.toTime;
        // const shiftEndTimeMax = shift?.shortByTime;
        // const database = shift?.database;

        const currentDate = req.body.currentDate;
        const shift = JSON?.parse(req.body.shift);
        const currentTime = req.body.currentTime;
        const formattedTime = convertTo24Hour(currentTime);
        const shiftStartTime = convertTo24Hour(shift?.fromTime);
        const lateByTime = convertTo24Hour(shift?.lateByTime);
        const shiftEndTime = convertTo24Hour(shift?.toTime);
        const shiftEndTimeMax = convertTo24Hour(shift?.shortByTime);
        const database = shift?.database;

        if (!inTimeStore[userId]) {
          console.log("formatted time", formattedTime);
          console.log("shiftStarttime", shiftStartTime);
          console.log("lateByTime", lateByTime);
          if (formattedTime > shiftStartTime && formattedTime < lateByTime) {
            const record = await AttendanceAws.findOne({
              userId: userId,
              currentDate: currentDate,
            });
            if (record) {
              return res.json({
                message: "You are already checked in for today.",
                status: false,
              });
            }
            inTimeStore[userId] = true;
            let late = false;
            let lateTime = "00:00:00";

            if (formattedTime > lateByTime) {
              late = true;
              const lateMilliseconds = formattedTime - lateByTime;
              lateTime = millisecondsToHHMMSS(lateMilliseconds);
            }
            const attendanceRecord = new AttendanceAws({
              userId: userId,
              fullName: fullName,
              intime: currentTime,
              late,
              lateTime,
              // shift: req.body.shift,
              currentDate: currentDate,
              branch: req.body.branch,
              shift: JSON?.parse(req.body.shift),
              database: database,
            });
            try {
              await attendanceRecord.save();
              return res.json({
                message: "In time marked successfully",
                userId,
                fullName,
                inTime: currentTime,
                shift,
                late,
                lateTime,
                database,
                status: true,
              });
            } catch (err) {
              console.error("Error saving inTime:", err);
              return res
                .status(500)
                .json({ error: "Internal server error", status: false });
            }
          } else {
            return res.status(400).json({
              message: "Invalid time of Intime Shift.",
              status: false,
            });
          }
        } else {
          console.log("formattedtime", formattedTime);
          console.log("shiftendtime", shiftEndTime);
          console.log("shiftendmax", shiftEndTimeMax);
          if (formattedTime > shiftEndTime && formattedTime < shiftEndTimeMax) {
            const record = await AttendanceAws.findOne({
              userId: userId,
              currentDate: currentDate,
            });
            if (record) {
              return res.json({
                message: "You are already checked Out for today.",
                status: false,
              });
            }
            try {
              const attendanceRecord = await AttendanceAws.findOneAndUpdate(
                { userId: userId, currentDate: currentDate },
                {
                  outtime: currentTime,
                  early: formattedTime < shiftEndTime,
                },
                { new: true }
              );
              if (!attendanceRecord) {
                return res.status(404).json({
                  message: "Attendance record not found for updating outTime",
                  status: false,
                });
              }
              delete inTimeStore[userId];
              return res.json({
                message: "Out time marked successfully",
                userId,
                fullName,
                outtime: currentTime,
                early: formattedTime < shiftEndTime,
                status: true,
              });
            } catch (err) {
              console.error("Error updating outTime:", err);
              return res
                .status(500)
                .json({ error: "Internal server error", status: false });
            }
          } else {
            return res.status(400).json({
              message: "Invalid time of OutTime Shift...",
              status: false,
            });
          }
        }
      }
    }

    res.json({ match: false, message: "No matching faces found" });
  } catch (error) {
    console.error("Error in face recognition:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// app.post(
//   "/api/recognize",
//   upload.single("image"),
//   async function (req, res, next) {
//     if (req.file) {
//       req.body.image = req.file.filename;
//     }
//     const dataLocal = new DataAttendance({
//       image: req.body.image,
//       currentTime: req.body.currentTime,
//       shift: req.body.shift,
//       currentDate: req.body.currentDate,
//       database: req.body.shift.database,
//       branch: req.body.branch,
//     });
//     await dataLocal.save();
//     try {
//       // const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, ""); //web
//       const base64Data = req.body.image.replace("data:image/jpeg;base64,", "");
//       // const base64Data = req.body.image.replace;
//       const imageBuffer = Buffer.from(base64Data, "base64");

//       if (!isValidImageFormat(imageBuffer)) {
//         return res.status(400).json({ error: "Invalid image format" });
//       }
//       const params = {
//         FaceMatchThreshold: 0,
//         CollectionId: req.body.collectionId,
//         Image: { Bytes: imageBuffer },
//         MaxFaces: 1,
//       };
//       console.log("collectionId", req.body.collectionId);
//       rekognition.searchFacesByImage(params, async function (err, data) {
//         if (err) {
//           console.error("Error in face recognition:", err);
//           return res
//             .status(500)
//             .json({ error: "Face recognition error", details: err });
//         }
//         // var jsn = JSON.stringify(data.FaceMatches[0].Face);
//         // res.send("Json output : " + jsn + " || Confidence: " + data.FaceMatches[0].Face.Confidence.toString() + " Match : " + data.FaceMatches[0].Similarity.toString());
//         const Match = data.FaceMatches[0].Similarity;
//         console.log("data.......", data);
//         console.log("Match", Match);
//         if (
//           Match > 90 &&
//           data.FaceMatches.length > 0 &&
//           data.FaceMatches[0].Face
//         ) {
//           const match = data.FaceMatches[0];
//           const userId = match.Face.ExternalImageId.split("-")[0];
//           const currentDate = req.body.currentDate;
//           const shift = JSON.parse(req.body.shift);
//           // const shift = req.body.shift;
//           const currentTime = req.body.currentTime;
//           const timeParts = currentTime.split(" ");
//           const time = timeParts[0];
//           const timeComponents = time.split(":");
//           const hours = timeComponents[0];
//           const minutes = timeComponents[1];
//           const formattedTime = `${hours}:${minutes}`;

//           const shiftStartTime = shift.fromTime;
//           const lateByTime = shift.lateByTime;
//           const shiftEndTime = shift.toTime;
//           const shiftEndTimeMax = shift.shortByTime;
//           const database = shift.database;
//           console.log(currentTime);
//           console.log(formattedTime);
//           console.log(shiftStartTime);
//           console.log(lateByTime);

//           if (!inTimeStore[userId]) {
//             console.log("called.....................");
//             if (formattedTime > shiftStartTime && formattedTime < lateByTime) {
//               console.log("called....-1");
//               const record = await AttendanceAws.findOne({
//                 userId: userId,
//                 currentDate: currentDate,
//               });

//               if (record) {
//                 return res.json({
//                   message: "You are already checked in for today.",
//                 });
//               }
//               inTimeStore[userId] = true;
//               console.log("called.........");
//               let late = false;
//               let lateTime = "00:00:00";

//               if (formattedTime > lateByTime) {
//                 console.log("checktime");
//                 late = true;
//                 const lateMilliseconds = formattedTime - lateByTime;
//                 lateTime = millisecondsToHHMMSS(lateMilliseconds);
//               }

//               const attendanceRecord = new AttendanceAws({
//                 userId,
//                 intime: formattedTime,
//                 late,
//                 lateTime,
//                 shift,
//                 currentDate: currentDate,
//                 branch: req.body.branch,
//                 database,
//               });
//               try {
//                 console.log("time saved  intime");
//                 await attendanceRecord.save();
//                 return res.json({
//                   message: "In time marked successfully",
//                   userId,
//                   inTime: formattedTime,
//                   shift,
//                   late,
//                   lateTime,
//                 });
//               } catch (err) {
//                 console.error("Error saving inTime:", err);
//                 return res
//                   .status(500)
//                   .json({ message: "Internal server error" });
//               }
//             } else {
//               console.log("error..........");
//               return res.status(400).json({
//                 error: "Invalid time of Intime Shift.",
//               });
//             }
//           } else {
//             console.log("currenttime", formattedTime);
//             console.log("shiftEndTime", shiftEndTime);
//             console.log("ShiftEndTimeMax", shiftEndTimeMax);
//             if (
//               formattedTime > shiftEndTime &&
//               formattedTime < shiftEndTimeMax
//             ) {
//               const record = await AttendanceAws.findOne({
//                 userId: userId,
//                 currentDate: currentDate,
//               });

//               if (record) {
//                 return res.json({
//                   message: "You are already checked Out for today.",
//                 });
//               }
//               try {
//                 console.log("saved outtime");
//                 const attendanceRecord = await AttendanceAws.findOneAndUpdate(
//                   { userId: userId, currentDate: currentDate },
//                   {
//                     outtime: formattedTime,
//                     early: formattedTime < shiftEndTime,
//                   },
//                   { new: true }
//                 );
//                 if (!attendanceRecord) {
//                   return res.status(404).json({
//                     message: "Attendance record not found for updating outTime",
//                   });
//                 }
//                 delete inTimeStore[userId];
//                 return res.json({
//                   message: "Out time marked successfully",
//                   userId,
//                   outtime: formattedTime,
//                   early: formattedTime < shiftEndTime,
//                 });
//               } catch (err) {
//                 console.error("Error updating outTime:", err);
//                 return res
//                   .status(500)
//                   .json({ message: "Internal server error" });
//               }
//             } else {
//               return res.status(400).json({
//                 error: "Invalid time of OutTime Shift...",
//               });
//             }
//           }
//         } else {
//           return res.status(400).json({ message: "No face matches found" });
//         }
//       });
//     } catch (error) {
//       console.error("Error handling recognition:", error);
//       return res.status(500).json({ error: "Internal server error" });
//     }
//   }
// );

function millisecondsToHHMMSS(ms) {
  const seconds = Math.floor(ms / 1000);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;

  return `${padZero(hh)}:${padZero(mm)}:${padZero(ss)}`;
}

function padZero(num) {
  return (num < 10 ? "0" : "") + num;
}

const s3 = new AWS.S3({
  accessKeyId: process.env.accessKeyId,
  secretAccessKey: process.env.secretAccessKey,
  region: process.env.region,
});

app.post("/api/register", upload.single("image"), async (req, res) => {
  try {
    const base64Data = req.body.image.replace("data:image/jpeg;base64,", "");
    // const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");

    if (!isValidImageFormat(imageBuffer)) {
      return res.status(400).json({ error: "Invalid image format" });
    }

    const params = {
      Bucket: process.env.Bucket,
      Key: `${req.body.fullName}-${req.body.userId}.jpg`,
      Body: imageBuffer,
      ContentEncoding: "base64",
      ContentType: "image/jpeg",
      ACL: "public-read",
    };

    s3.upload(params, async (err, data) => {
      if (err) {
        console.log("Error uploading file to S3:", err);
        return res.status(500).json({ error: "Error uploading file to S3." });
      }

      const imageUrl = data.Location;
      const registrationData = {
        userId: req.body.userId,
        imageUrl,
        image: req.body.image,
      };
      // fs.unlinkSync(req.file.path);
      await indexFaces(req, res, registrationData);
    });
  } catch (error) {
    console.log("Error registering:", error);
    res.status(500).json({ error: "Error registering" });
  }
});

const isValidImageFormat = (imageBuffer) => {
  if (!Buffer.isBuffer(imageBuffer)) {
    return false;
  }

  if (imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8) {
    return true;
  } else if (
    imageBuffer[0] === 0x89 &&
    imageBuffer[1] === 0x50 &&
    imageBuffer[2] === 0x4e &&
    imageBuffer[3] === 0x47 &&
    imageBuffer[4] === 0x0d &&
    imageBuffer[5] === 0x0a &&
    imageBuffer[6] === 0x1a &&
    imageBuffer[7] === 0x0a
  ) {
    return true;
  }
  return false;
};
const indexFaces = async (req, res, registerData) => {
  try {
    const paths = klawSync("./faces", { nodir: true, ignore: ["*.json"] });

    for (const file of paths) {
      const imageBuffer = fs.readFileSync(file.path);
      if (!isValidImageFormat(imageBuffer)) {
        console.error("Unsupported image format");
        continue;
      }
      try {
        const params = {
          CollectionId: req.body.collectionId,
          DetectionAttributes: ["ALL"],
          ExternalImageId: `${registerData.userId}-${req.body.fullName}`,
          Image: {
            Bytes: imageBuffer,
          },
        };
        await new Promise((resolve, reject) => {
          rekognition.indexFaces(params, async (err, data) => {
            if (err) {
              console.error("Error indexing faces:", err);
              if (err.code === "InvalidImageFormatException") {
                console.log(
                  "Invalid image format detected. Check the image being passed."
                );
                return res.status(400).json({ error: "Invalid image format" });
              }
              reject(err);
              return;
            }
            try {
              await indexFacesAndUpdate(req, res, registerData, data);
              await fs.writeJson(file.path + ".json", JSON.stringify(data));
              resolve();
            } catch (error) {
              console.log("Error updating or writing JSON:", error);
              reject(error);
            }
          });
        });
      } catch (error) {
        console.log("Error processing image:", error);
      }
    }
  } catch (error) {
    console.log("Error processing images:", error);
    res.status(500).json({ error: "Error processing images" });
  }
};

const indexFacesAndUpdate = async (
  req,
  res,
  registerData,
  rekognitionResponse
) => {
  try {
    const id = registerData.userId;
    const faceId = rekognitionResponse.FaceRecords[0].Face.FaceId;
    const externalImageId =
      rekognitionResponse.FaceRecords[0].Face.ExternalImageId;
    const imageUrl = registerData.imageUrl;
    const updateUserUrl = `https://customer-node.rupioo.com/user/update-user/${id}`;
    const updateData = {
      faceId,
      externalImageId,
      image: imageUrl,
      imageUrl,
    };
    const response = await axios.post(updateUserUrl, updateData);
    console.log("Update successful:", response.data);
    res.status(200).json({
      message: "Image uploaded and processed successfully",
      updateData,
      rekognitionResponse,
    });
  } catch (error) {
    console.log("Error updating data:", error);
    res.status(500).json({ error: "Error updating data" });
  }
};

app.get("/api/attendanceAws/:database", async function (req, res, next) {
  try {
    const Attendance = await AttendanceAws.find({
      database: req.params.database,
    });
    return Attendance
      ? res.status(200).json({
          message: "AttendenceList Found Successfully ..!",
          Attendance: Attendance,
          status: true,
        })
      : res
          .status(404)
          .json({ message: "AttendanceList Not Found", status: false });
  } catch (error) {
    console.log(error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", status: false });
  }
});

app.get("/api/attendanceAwsById/:id", async function (req, res, next) {
  try {
    const id = req.params.id;
    const Attendance = await AttendanceAws.find({ _id: id });
    return Attendance
      ? res.status(200).json({
          message: "AttendenceList Found Successfully ..!",
          Attendance: Attendance,
          status: true,
        })
      : res
          .status(404)
          .json({ message: "AttendanceList Not Found", status: false });
  } catch (error) {
    console.log(error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", status: false });
  }
});

app.get("/api/localDataAttendance/:database", async function (req, res, next) {
  try {
    const Attendance = await DataAttendance.find({
      database: req.params.database,
    });
    return Attendance
      ? res.status(200).json({
          message: "AttendenceList Found Successfully ..!",
          Attendance: Attendance,
          status: true,
        })
      : res
          .status(404)
          .json({ message: "AttendanceList Not Found", status: false });
  } catch (error) {
    console.log(error);
    return res
      .status(500)
      .json({ error: "Internal Server Error", status: false });
  }
});

app.get("/api/listCollections", (req, res) => {
  try {
    rekognition.listCollections({}, (err, data) => {
      if (err) {
        console.error("Error listing collections:", err);
        return res.status(500).json({ error: "Error listing collections" });
      } else {
        console.log("Collections listed successfully:");
        return res.status(200).json({ collections: data.CollectionIds });
      }
    });
  } catch (error) {
    console.error("Error listing collections:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/deleteFace", upload.single("image"), async (req, res) => {
  try {
    const { collectionId, faceId } = req.body;
    if (!collectionId || !faceId) {
      return res
        .status(400)
        .json({ error: "Collection ID and Face ID are required" });
    }
    rekognition.deleteFaces(
      {
        CollectionId: collectionId,
        FaceIds: [faceId],
      },
      (err, data) => {
        if (err) {
          console.error("Error deleting face:", err);
          return res.status(500).json({ error: "Error deleting face" });
        } else {
          console.log("Face deleted successfully:", data);
          return res.status(200).json({ message: "Face deleted successfully" });
        }
      }
    );
  } catch (error) {
    console.error("Error deleting face:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/user-List", upload.single("image"), function (req, res) {
  try {
    userList(req, res);
  } catch (error) {
    console.error("Error UserList data:", error);
    res.status(500).json({ error: "Error UserList" });
  }
});

function userList(req, res) {
  console.log(req.body);
  rekognition.listFaces(
    { CollectionId: req.body.collectionId },
    function (err, data) {
      if (err) {
        console.error("Error listing faces:", err);
        res.status(500).json({ error: "Error listing faces" });
      } else {
        console.log("List of faces:", data);
        res.status(200).json({
          value: {
            data: data,
            totalNumber: data?.length,
          },
        });
      }
    }
  );
}

app.post("/api/deletecollection", upload.single("image"), function (req, res) {
  deleteCollection(req, res);
});

function deleteCollection(req, res) {
  rekognition.deleteCollection(
    { CollectionId: req.body.collectionId },
    function (err, data) {
      if (err) {
        console.error("Error deleting collection:", err);
        res.status(500).send(err);
      } else {
        console.log("Collection deleted successfully:", data);
        res.json(data);
      }
    }
  );
}

app.post("/api/createcollection", function (req, res) {
  createCollection(req, res);
});

function createCollection(req, res) {
  const { collectionId } = req.body;

  if (!collectionId) {
    return res.status(400).send("CollectionId is required");
  }

  rekognition.createCollection(
    { CollectionId: collectionId },
    function (err, data) {
      if (err) {
        console.error("Error creating collection:", err);
        return res.status(500).send(err.message);
      } else {
        console.log("Collection created successfully:", data);
        return res
          .status(200)
          .json({ message: "Collection Created", data: data });
      }
    }
  );
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
