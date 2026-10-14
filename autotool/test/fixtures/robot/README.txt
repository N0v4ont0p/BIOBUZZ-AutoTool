AutoRunner.java.txt and SampleAutoPaths.java.txt are copies of the robot repo's files. Refresh after the robot's
Leg (or the sample route) changes:

  R=/path/to/robot/TeamCode/src/main/java/org/firstinspires/ftc/teamcode/opmodes
  cp $R/AutoRunner.java test/fixtures/robot/AutoRunner.java.txt
  cp $R/SampleAutoPaths.java test/fixtures/robot/SampleAutoPaths.java.txt

Run the live check against the real robot repo with:  AUTOTOOL_ROBOT_REPO=/path/to/robot/repo npm test
